// onair-show.js — 📺 a picture / link card on Pepe's OBS (1.99acw, views/onairShow.ejs; onair.js on the server). OBS's browser
// source loads the page; this script only:
//   * sizes the corner box (data-pct % of the width - set here, the CSP allows no inline style),
//   * reports the main picture's load / error to POST /api/onair/show/state {t, state, w, h} (a direct picture that doesn't load
//     is taken off - a site that blocks hotlinking, a redirect elsewhere),
//   * reports every 5 s ("showing"); the server answers {on: false} once this pick is no longer on air -> the page blanks,
//   * blanks itself past data-until (+5 s) when the site hasn't answered for a while (the network is gone).
(function () {
  'use strict';
  var box = document.getElementById('oaShow');
  if (!box) return;
  var TOKEN = box.getAttribute('data-token') || '';
  var UNTIL = Number(box.getAttribute('data-until')) || 0;
  var PCT = Number(box.getAttribute('data-pct')) || 30;
  var stopped = false, lastOk = Date.now(), timer = null;
  if (box.getAttribute('data-lane') === 'corner') box.style.width = Math.max(15, Math.min(50, PCT)) + 'vw';
  function blank() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    box.classList.add('oas-gone');
    try { box.parentNode.removeChild(box); } catch (e) { /* gone */ }
  }
  function report(state, w, h) {
    if (stopped) return;
    fetch('/api/onair/show/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', credentials: 'omit',
      body: JSON.stringify({ t: TOKEN, state: state, w: w || 0, h: h || 0 }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { lastOk = Date.now(); if (j && j.on === false) blank(); })
      .catch(function () { /* the next report */ });
  }
  var img = box.querySelector('img.oas-main');
  if (img) {
    var loaded = function () { report('loaded', img.naturalWidth, img.naturalHeight); };
    var failed = function () { report('error'); };
    if (img.complete) { if (img.naturalWidth) loaded(); else failed(); }
    else { img.addEventListener('load', loaded); img.addEventListener('error', failed); }
  } else report('loaded');
  // a card's own pictures (its preview / favicon) failing never ends the card - they just disappear
  Array.prototype.forEach.call(box.querySelectorAll('img.oas-pic, img.oas-icon'), function (im) {
    im.addEventListener('error', function () { im.style.display = 'none'; });
  });
  timer = setInterval(function () {
    if (UNTIL && Date.now() > UNTIL + 5000 && Date.now() - lastOk > 10000) return blank();
    report('showing');
  }, 5000);
})();
