// Coin-op slot for the gold wheel (views/wheel.ejs).
// Press the coin: it flips up into the lit slot. If the server accepts the spin, it drops through
// with a clunk and the CREDIT counter ticks to 01 (the wheel then spins and the credit is used).
// If the spin is refused (low balance, daily limit, signed out, spin in progress) the coin pops
// back out of the slot and falls back to the button with the reason in the status line.
// Needs script.js first (window.userSpin / window.setSpinStatus / window.wheelBalance).
(function () {
  'use strict';
  var COST = 5000;
  var MUTE_KEY = 'patv.wheel.muted';
  var reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  var btn = document.getElementById('spinButton');
  var btnCoin = btn && btn.querySelector('.aw-coin');
  var panel = document.getElementById('coinop');
  var fly = document.getElementById('flyCoin');
  var clip = document.getElementById('dropClip');
  var clipCoin = document.getElementById('clipCoin');
  var slot = document.getElementById('coinSlot');
  var credit = document.getElementById('creditCount');
  var credEl = credit && credit.parentNode;
  var muteBtn = document.getElementById('muteBtn');
  var frame = document.getElementById('wheelFrame');
  if (!btn || !panel || !fly || !clip || !clipCoin || !slot) return;

  // ---------- sound (WebAudio, synthesized; only created after a click) ----------
  var muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) {}
  window.wheelMuted = muted;
  function paintMute() {
    if (!muteBtn) return;
    muteBtn.textContent = muted ? 'SOUND OFF' : 'SOUND ON';
    muteBtn.removeAttribute('aria-pressed');
  }
  paintMute();
  if (muteBtn) muteBtn.addEventListener('click', function () {
    muted = !muted;
    window.wheelMuted = muted;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) {}
    paintMute();
  });

  var actx = null;
  function audio() {
    if (muted) return null;
    try {
      if (!actx) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; actx = new AC(); }
      if (actx.state === 'suspended') actx.resume();
      return actx;
    } catch (e) { return null; }
  }
  function tone(type, f0, f1, t0, dur, vol) {
    var a = audio(); if (!a) return;
    var o = a.createOscillator(), g = a.createGain(), t = a.currentTime + (t0 || 0);
    o.type = type; o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.15, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(t0, dur, vol, freq) {
    var a = audio(); if (!a) return;
    var len = Math.max(1, Math.floor(a.sampleRate * dur)), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    var s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain(), t = a.currentTime + (t0 || 0);
    s.buffer = buf; f.type = 'lowpass'; f.frequency.value = freq || 900; g.gain.value = vol || 0.4;
    s.connect(f); f.connect(g); g.connect(a.destination); s.start(t);
  }
  var sfx = {
    flip:   function () { tone('sine', 2200, 2600, 0, 0.06, 0.05); },
    clink:  function () { tone('sine', 2637, 0, 0, 0.12, 0.09); tone('sine', 3520, 0, 0.03, 0.10, 0.06); },
    clunk:  function () { noise(0, 0.12, 0.5, 700); tone('sine', 110, 55, 0, 0.18, 0.35); },
    credit: function () { tone('square', 988, 0, 0.10, 0.08, 0.06); tone('square', 1319, 0, 0.19, 0.14, 0.06); },
    reject: function () { tone('sawtooth', 150, 110, 0, 0.28, 0.08); tone('sine', 1800, 900, 0.12, 0.14, 0.05); },
  };

  // ---------- geometry ----------
  function rel(el, host) {
    var r = el.getBoundingClientRect(), h = host.getBoundingClientRect();
    return { x: r.left - h.left + r.width / 2, y: r.top - h.top + r.height / 2, w: r.width, h: r.height };
  }
  var S = 56;   // flying coin size (CSS --s on .aw-coin)
  function slitY(host) {   // the slit line = the clip region's bottom edge
    var c = clip.getBoundingClientRect(), h = host.getBoundingClientRect();
    return c.bottom - h.top;
  }
  function place(el, x, y) { el.style.transform = 'translate(' + (x - S / 2) + 'px,' + (y - S / 2) + 'px)'; }
  function anim(el, frames, opts) {
    if (!el.animate) return Promise.resolve();
    var a = el.animate(frames, Object.assign({ fill: 'forwards' }, opts));
    return a.finished ? a.finished.catch(function () {}) : new Promise(function (r) { a.onfinish = r; });
  }
  function T(x, y, extra) { return 'translate(' + (x - S / 2) + 'px,' + (y - S / 2) + 'px)' + (extra ? ' ' + extra : ''); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---------- state ----------
  var busy = false, startTimer = null;
  function setBusy(b) {
    busy = b;
    btn.setAttribute('aria-disabled', b ? 'true' : 'false');
    panel.classList.toggle('busy', b);
  }
  function setCredit(n) {
    if (!credit) return;
    credit.textContent = (n < 10 ? '0' : '') + n;
    if (credEl && !reduce) { credEl.classList.remove('tick'); void credEl.offsetWidth; credEl.classList.add('tick'); }
  }
  function flashSlot(kind) {
    slot.classList.remove('ok', 'bad'); void slot.offsetWidth;
    if (kind) slot.classList.add(kind);
    setTimeout(function () { slot.classList.remove(kind); }, kind === 'ok' ? 1600 : 900);
  }
  function status(msg, kind, html) { if (window.setSpinStatus) window.setSpinStatus(msg, kind, html); }

  // Phase A: from the button, flip up and dip half into the slot.
  function insert() {
    if (reduce) return Promise.resolve();
    var a = rel(btnCoin, panel), slotC = rel(slot, panel), sy = slitY(panel);
    var hover = { x: slotC.x, y: sy - S / 2 - 6 };
    var scale0 = a.w / S;
    btn.classList.add('spent');
    fly.style.visibility = 'visible';
    place(fly, a.x, a.y);
    sfx.flip();
    var midX = (a.x + hover.x) / 2, midY = Math.min(a.y, hover.y) - 70;
    return anim(fly, [
      { transform: T(a.x, a.y, 'scale(' + scale0 + ') rotateY(0deg)') },
      { transform: T(midX, midY, 'scale(1.1) rotateY(540deg)'), offset: 0.55 },
      { transform: T(hover.x, hover.y, 'scale(1) rotateY(720deg)') }
    ], { duration: 620, easing: 'cubic-bezier(.3,.7,.4,1)' }).then(function () {
      // hand over to the clipped coin, then dip into the slit
      var c = clip.getBoundingClientRect(), h = panel.getBoundingClientRect();
      var cx = hover.x - (c.left - h.left), cy = hover.y - (c.top - h.top);
      clipCoin.style.visibility = 'visible';
      clipCoin.style.transform = T(cx, cy);
      fly.style.visibility = 'hidden';
      clipCoin._pos = { x: cx, y: cy };
      sfx.clink();
      return anim(clipCoin, [{ transform: T(cx, cy) }, { transform: T(cx, cy + S * 0.45) }], { duration: 180, easing: 'ease-in' });
    });
  }

  // Phase B (accepted): drop the rest of the way through.
  function accept() {
    if (!reduce && clipCoin._pos) {
      var p = clipCoin._pos;
      return anim(clipCoin, [{ transform: T(p.x, p.y + S * 0.45) }, { transform: T(p.x, p.y + S * 1.15) }], { duration: 160, easing: 'ease-in' })
        .then(function () { clipCoin.style.visibility = 'hidden'; done(); });
    }
    done();
    return Promise.resolve();
    function done() {
      sfx.clunk(); sfx.credit();
      flashSlot('ok');
      setCredit(1);
    }
  }

  // Phase B (refused): pop back out of the slot and bounce back down to the button.
  function eject() {
    sfx.reject();
    flashSlot('bad');
    if (reduce || !clipCoin._pos) { btn.classList.remove('spent'); return Promise.resolve(); }
    var p = clipCoin._pos;
    return anim(clipCoin, [{ transform: T(p.x, p.y + S * 0.45) }, { transform: T(p.x, p.y - 4) }], { duration: 150, easing: 'ease-out' })
      .then(function () {
        var c = clip.getBoundingClientRect(), h = panel.getBoundingClientRect();
        var x0 = p.x + (c.left - h.left), y0 = p.y - 4 + (c.top - h.top);
        var b = rel(btnCoin, panel), sc = b.w / S;
        fly.style.visibility = 'visible';
        fly.style.transform = T(x0, y0);
        clipCoin.style.visibility = 'hidden';
        return anim(fly, [
          { transform: T(x0, y0, 'rotate(0deg)') },
          { transform: T(x0 + 24, y0 - 46, 'rotate(-40deg)'), offset: 0.22 },
          { transform: T(b.x, b.y, 'scale(' + sc + ') rotate(-200deg)'), offset: 0.7, easing: 'ease-out' },
          { transform: T(b.x, b.y - 14, 'scale(' + sc + ') rotate(-230deg)'), offset: 0.84, easing: 'ease-in' },
          { transform: T(b.x, b.y, 'scale(' + sc + ') rotate(-360deg)') }
        ], { duration: 720, easing: 'ease-in' });
      })
      .then(function () {
        fly.style.visibility = 'hidden';
        btn.classList.remove('spent');
        tone('sine', 1760, 0, 0, 0.07, 0.05);
      });
  }

  function refuse(msg, html) {
    status(msg, 'err', html);
    return eject();
  }

  function release() {
    clearTimeout(startTimer);
    btn.classList.remove('spent');
    if (frame) frame.classList.remove('spinning');
    setBusy(false);
  }

  btn.addEventListener('click', function () {
    if (busy) return;
    setBusy(true);
    audio();   // unlock audio inside the user gesture
    // script.js waits on this before spinning, so the wheel starts after the coin drops in.
    var openGate;
    window.wheelCoinGate = new Promise(function (r) { openGate = r; });

    // Cheap pre-checks (the server still decides): bounce straight back without a request.
    var bal = window.wheelBalance;
    var left = window.wheelSpinsLeft;
    var pre = null, preHtml = false;
    if (typeof bal === 'number' && !isNaN(bal) && bal < COST) {
      pre = 'Not enough PAT: a spin costs 5,000 and you have ' + bal.toLocaleString() + '.';
    } else if (left === 0) {
      pre = 'No spins left today. Level up or buy <a href="/shop">+100 Daily Gold Spins</a>.'; preHtml = true;
    }

    var req = pre ? null : (window.userSpin ? window.userSpin() : Promise.resolve({ ok: false, message: 'The wheel is still loading. Try again in a second.' }));
    status(pre ? '' : 'Inserting coin…', '');

    Promise.all([insert(), req || Promise.resolve(null), reduce ? 0 : wait(120)]).then(function (r) {
      var res = r[1];
      if (pre) return refuse(pre, preHtml).then(release).then(openGate);
      if (!res || !res.ok) {
        openGate();
        var m = (res && res.message) || 'The coin was rejected. Try again.';
        if (res && res.login) return refuse('Your session expired. <a href="/login">Sign in</a> to play.', true).then(release);
        if (/insufficient/i.test(m)) m = 'Not enough PAT: a spin costs 5,000.';
        var esc = m.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
        if (/shop/i.test(m)) return refuse(esc.replace(/shop/i, '<a href="/shop">shop</a>'), true).then(release);
        return refuse(m).then(release);
      }
      return accept().then(function () {
        status('CREDIT 01. Here we go!', 'ok');
        setTimeout(openGate, reduce ? 0 : 450);
        // The server pushes the spin over the event stream; give it a moment before giving up.
        startTimer = setTimeout(function () {
          setCredit(0);
          status('The wheel did not start. Refresh the page and try again.', 'err');
          release();
        }, 20000);
      });
    });
  });

  // Wheel lifecycle (fired by script.js)
  document.addEventListener('wheel:spinstart', function () {
    clearTimeout(startTimer);
    setCredit(0);          // the credit is spent on this spin
    if (frame) { frame.classList.add('spinning'); frame.classList.remove('won'); }
  });
  document.addEventListener('wheel:result', function (e) {
    var d = (e && e.detail) || {};
    release();
    if (frame && Number(d.result) > 0) {
      frame.classList.add('won');
      setTimeout(function () { frame.classList.remove('won'); }, 4000);
    }
    if (d.result !== undefined) addLog(d);
  });

  // ---------- this-session log ----------
  var log = document.getElementById('spinLog');
  function addLog(d) {
    if (!log) return;
    var empty = log.querySelector('.empty');
    if (empty) empty.remove();
    var li = document.createElement('li');
    var t = document.createElement('span'); t.className = 't';
    var now = new Date();
    t.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var w = document.createElement('span');
    var won = Number(d.result) || 0;
    if (d.grand) { w.className = 'jp'; w.textContent = 'GRAND JACKPOT +' + won.toLocaleString(); }
    else if (d.jackpot) { w.className = 'jp'; w.textContent = 'JACKPOT ' + (d.jackpotPct || 0) + '% +' + won.toLocaleString(); }
    else if (won > 0) { w.className = 'w'; w.textContent = '+' + won.toLocaleString() + ' PAT'; }
    else { w.className = 'z'; w.textContent = 'no prize'; }
    li.appendChild(t); li.appendChild(w);
    log.insertBefore(li, log.firstChild);
    while (log.children.length > 10) log.removeChild(log.lastChild);
  }
})();
