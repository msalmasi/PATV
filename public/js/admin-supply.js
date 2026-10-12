// admin-supply.js — the /admin/economy "Supply history" card (1.99jw): GET /api/admin/econ/supply-history (Admin) drawn as
// small inline SVG charts (no chart library): total supply, the Federal Reserve against its band, and the day's mints
// stacked by source next to that day's burns; plus a month-to-date mints-vs-cap table from Pepe's last push.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  if (!$('shTotal')) return;
  var NS = 'http://www.w3.org/2000/svg';
  var W = 640, H = 180, PL = 64, PR = 10, PT = 10, PB = 24;
  var COLORS = { issuance: '#4caf50', floor: '#29b6f6', admin: '#ef5350', loan: '#ffa726', restore: '#ab47bc', donation: '#ec407a', seed: '#8d6e63', cutover: '#78909c' };
  var EXTRA = ['#26a69a', '#d4e157', '#5c6bc0', '#ff7043'];
  var BURN = '#ff5722';
  var n = function (x) { return Number(x || 0).toLocaleString('en-US'); };
  var short = function (x) {
    var a = Math.abs(x);
    if (a >= 1e9) return (x / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
    if (a >= 1e6) return (x / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e3) return (x / 1e3).toFixed(0) + 'k';
    return String(Math.round(x));
  };
  function el(tag, attrs, text) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  function frame(host, lo, hi, days, label) {
    host.textContent = '';
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': label });
    if (hi === lo) { hi = lo + 1; }
    var y = function (v) { return PT + (H - PT - PB) * (1 - (v - lo) / (hi - lo)); };
    var step = (W - PL - PR) / Math.max(1, days.length);
    var x = function (i) { return PL + step * (i + 0.5); };
    for (var g = 0; g <= 4; g++) {
      var v = lo + (hi - lo) * g / 4;
      svg.appendChild(el('line', { x1: PL, x2: W - PR, y1: y(v), y2: y(v), stroke: 'currentColor', 'stroke-opacity': 0.12 }));
      svg.appendChild(el('text', { x: PL - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'currentColor', 'fill-opacity': 0.7 }, short(v)));
    }
    var every = Math.max(1, Math.ceil(days.length / 8));
    days.forEach(function (d, i) {
      if (i % every === 0 || i === days.length - 1) svg.appendChild(el('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', 'font-size': 10, fill: 'currentColor', 'fill-opacity': 0.7 }, d.slice(5)));
    });
    host.appendChild(svg);
    return { svg: svg, x: x, y: y, step: step };
  }
  function line(c, pts, color, dash, title) {
    var d = pts.filter(function (p) { return p[1] !== null && p[1] !== undefined; }).map(function (p, i) { return (i ? 'L' : 'M') + c.x(p[0]).toFixed(1) + ' ' + c.y(p[1]).toFixed(1); }).join(' ');
    if (!d) return;
    var path = el('path', { d: d, fill: 'none', stroke: color, 'stroke-width': 2 });
    if (dash) path.setAttribute('stroke-dasharray', '5 4');
    if (title) path.appendChild(el('title', {}, title));
    c.svg.appendChild(path);
    pts.forEach(function (p) {
      if (p[1] === null || p[1] === undefined) return;
      var dot = el('circle', { cx: c.x(p[0]), cy: c.y(p[1]), r: 2.5, fill: color });
      dot.appendChild(el('title', {}, (title || '') + ' ' + p[2] + ': ' + n(p[1])));
      c.svg.appendChild(dot);
    });
  }
  var span = function (vals) {
    var v = vals.filter(function (x) { return x !== null && x !== undefined && isFinite(x); });
    if (!v.length) return [0, 1];
    var lo = Math.min.apply(null, v), hi = Math.max.apply(null, v);
    var pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.02 || 1;
    return [Math.max(0, lo - pad), hi + pad];
  };

  fetch('/api/admin/econ/supply-history?days=90', { cache: 'no-store' }).then(function (r) { return r.status === 403 ? null : r.json(); }).then(function (d) {
    var st = $('shStatus');
    if (!d) { st.textContent = 'Admins only.'; return; }
    if (!d.ok) { st.textContent = 'Could not load: ' + (d.error || 'error'); return; }
    var rows = d.rows || [];
    var days = rows.map(function (r) { return r.day; });
    if (!rows.length) {
      st.textContent = 'No days recorded yet - the first row is written with Pepe’s next supply snapshot.';
    } else {
      var last = rows[rows.length - 1];
      st.textContent = rows.length + ' day(s) · today ' + n(last.total) + ' PAT total, ' + n(last.circulating) + ' circulating · month to date '
        + (last.mtd_inflation_pct >= 0 ? '+' : '') + Number(last.mtd_inflation_pct || 0).toFixed(2) + '%';
      // 1. total supply
      var tv = rows.map(function (r) { return r.total; });
      var s1 = span(tv);
      var c1 = frame($('shTotal'), s1[0], s1[1], days, 'Total PAT supply per day');
      line(c1, rows.map(function (r, i) { return [i, r.total, r.day]; }), '#4caf50', false, 'total');
      // 2. the Fed vs its band
      var fv = [], fl = [], ce = [];
      rows.forEach(function (r, i) {
        var b = r.band || {};
        fv.push([i, r.fed, r.day]); fl.push([i, b.floor === undefined ? null : b.floor, r.day]); ce.push([i, b.ceiling === undefined ? null : b.ceiling, r.day]);
      });
      var s2 = span([].concat(fv, fl, ce).map(function (p) { return p[1]; }));
      var c2 = frame($('shFed'), s2[0], s2[1], days, 'Federal Reserve balance against its floor and ceiling');
      line(c2, fl, '#ef5350', true, 'floor');
      line(c2, ce, '#ffa726', true, 'ceiling');
      line(c2, fv, '#29b6f6', false, 'Fed');
      // 3. mints stacked by source vs burns
      var srcs = [];
      rows.forEach(function (r) { Object.keys(r.mints || {}).forEach(function (k) { if (srcs.indexOf(k) < 0) srcs.push(k); }); });
      var color = function (k, i) { return COLORS[k] || EXTRA[i % EXTRA.length]; };
      var tot = rows.map(function (r) { return srcs.reduce(function (s, k) { return s + (Number((r.mints || {})[k]) || 0); }, 0); });
      var hi = Math.max.apply(null, tot.concat(rows.map(function (r) { return r.burns || 0; })).concat([1]));
      var c3 = frame($('shMints'), 0, hi * 1.08, days, 'PAT minted per day by source, and PAT burned');
      var bw = Math.max(2, c3.step * 0.38);
      rows.forEach(function (r, i) {
        var base = 0;
        srcs.forEach(function (k, j) {
          var v = Number((r.mints || {})[k]) || 0;
          if (!v) return;
          var rect = el('rect', { x: c3.x(i) - bw - 1, y: c3.y(base + v), width: bw, height: Math.max(0.5, c3.y(base) - c3.y(base + v)), fill: color(k, j) });
          rect.appendChild(el('title', {}, r.day + ' ' + k + ': ' + n(v) + ' PAT minted'));
          c3.svg.appendChild(rect);
          base += v;
        });
        if (r.burns) {
          var b = el('rect', { x: c3.x(i) + 1, y: c3.y(r.burns), width: bw, height: Math.max(0.5, c3.y(0) - c3.y(r.burns)), fill: BURN });
          b.appendChild(el('title', {}, r.day + ' burned: ' + n(r.burns) + ' PAT'));
          c3.svg.appendChild(b);
        }
      });
      var lg = $('shLegend');
      lg.innerHTML = '';
      srcs.concat(['burned']).forEach(function (k, j) {
        var s = document.createElement('span');
        var i = document.createElement('i');
        i.style.background = k === 'burned' ? BURN : color(k, j);
        s.appendChild(i); s.appendChild(document.createTextNode(k));
        lg.appendChild(s);
      });
    }
    // month-to-date mints vs caps (Pepe's last push)
    var m = d.monetary, tb = $('shMtd');
    tb.innerHTML = '';
    var keys = m && m.mtd ? Object.keys(m.mtd) : [];
    if (!keys.length) { tb.innerHTML = '<tr><td colspan="3" class="empty">Pepe hasn’t pushed month-to-date mints yet.</td></tr>'; return; }
    keys.forEach(function (k) {
      var x = m.mtd[k], tr = document.createElement('tr');
      var over = x.cap >= 0 && x.minted > x.cap;
      [k + (m.month ? ' (' + m.month + ')' : ''), n(x.minted), x.cap < 0 ? 'unlimited' : n(x.cap)].forEach(function (v, i) {
        var td = document.createElement('td');
        if (i) td.className = 'num';
        td.textContent = v;
        if (i === 1 && over) td.style.color = '#ef5350';
        tr.appendChild(td);
      });
      tb.appendChild(tr);
      // 1.99tq: the promo part of this month's donation mints (site donation promos), shown under "donation" - not a separate mint
      if (k === 'donation' && d.donation_promo) {
        var pp = 0, px = 0;
        Object.keys(d.donation_promo).forEach(function (day) { pp += d.donation_promo[day].pat || 0; px += d.donation_promo[day].extra || 0; });
        if (pp) {
          var r2 = document.createElement('tr');
          ['  of which at a promo rate (above the normal rate: ' + n(px) + ')', n(pp), ''].forEach(function (v, i) { var td = document.createElement('td'); if (i) td.className = 'num'; td.textContent = v; r2.appendChild(td); });
          tb.appendChild(r2);
        }
      }
    });
  }).catch(function () { $('shStatus').textContent = 'Could not reach the server.'; });
})();
