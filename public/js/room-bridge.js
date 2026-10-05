// room-bridge.js — shared pieces of the Camfrog room bridge UI, used by the room page (views/room.ejs)
// and the homepage's live room panel (views/home.ejs):
//   PATVRoom.audio(el, slug)   mini player for the room's live audio (play/pause, volume + mute,
//                              live / buffering state, jump to live, level meter)
//   PATVRoom.relay(el, slug)   the "say something" box (Pepe relays it into the room as "🌐 you (web)")
// Both are driven by the live view JSON: call .update(d) with each poll result.
// Everything user-visible goes in via textContent.
(function () {
  'use strict';
  var reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, String(v)); } catch (e) { return null; } return null; }

  // ── room audio mini player ──
  function audio(host, slug) {
    var box = el('div', 'rb-audio hide');
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Room audio');
    var play = el('button', 'rb-btn rb-play', '▶'); play.type = 'button'; play.setAttribute('aria-label', 'Listen live');
    var state = el('span', 'rb-state', 'Room audio');
    var meter = el('span', 'rb-meter'); meter.setAttribute('aria-hidden', 'true');
    var bars = [el('i'), el('i'), el('i'), el('i'), el('i')]; bars.forEach(function (b) { meter.appendChild(b); });
    var mute = el('button', 'rb-btn rb-mute', '🔊'); mute.type = 'button'; mute.setAttribute('aria-label', 'Mute');
    var vol = el('input', 'rb-vol'); vol.type = 'range'; vol.min = '0'; vol.max = '100'; vol.step = '5'; vol.setAttribute('aria-label', 'Volume');
    var jump = el('button', 'rb-btn rb-jump hide', 'Jump to live'); jump.type = 'button';
    var au = el('audio'); au.preload = 'none';
    [play, state, meter, mute, vol, jump, au].forEach(function (x) { box.appendChild(x); });
    host.appendChild(box);

    var playing = false, startedAt = 0, actx = null, analyser = null, raf = null, available = false;
    var v0 = Number(store('patvRoomVol')); vol.value = isFinite(v0) && store('patvRoomVol') !== null ? Math.max(0, Math.min(100, v0)) : 80;
    au.volume = vol.value / 100;
    au.muted = store('patvRoomMuted') === '1';
    function paint() {
      play.textContent = playing ? '❚❚' : '▶';
      play.setAttribute('aria-label', playing ? 'Pause room audio' : 'Listen live');
      play.setAttribute('aria-pressed', playing ? 'true' : 'false');
      mute.textContent = au.muted || au.volume === 0 ? '🔇' : '🔊';
      mute.setAttribute('aria-label', au.muted ? 'Unmute' : 'Mute');
      mute.setAttribute('aria-pressed', au.muted ? 'true' : 'false');
      box.classList.toggle('on', playing);
    }
    function setState(t, cls) { state.textContent = t; state.className = 'rb-state' + (cls ? ' ' + cls : ''); }
    function meterLoop() {
      if (!analyser || !playing) { bars.forEach(function (b) { b.style.height = ''; }); return; }
      var d = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(d);
      var n = bars.length, step = Math.floor(d.length / (n * 2)) || 1;
      for (var i = 0; i < n; i++) { var v = d[i * step] / 255; bars[i].style.height = Math.max(2, Math.round(v * 14)) + 'px'; }
      raf = requestAnimationFrame(meterLoop);
    }
    function wireMeter() {
      if (reduce || analyser) return;
      try {
        var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
        actx = actx || new AC();
        var src = actx.createMediaElementSource(au);       // same-origin stream, so no CORS issue
        analyser = actx.createAnalyser(); analyser.fftSize = 64;
        src.connect(analyser); analyser.connect(actx.destination);
      } catch (e) { analyser = null; }
    }
    function start() {
      au.src = '/rooms/' + encodeURIComponent(slug) + '/audio?t=' + Date.now();
      wireMeter();
      if (actx && actx.state === 'suspended') actx.resume();
      setState('connecting…', 'wait');
      au.play().then(function () { playing = true; startedAt = Date.now(); paint(); meterLoop(); store('patvRoomAudio', 1); })
        .catch(function () { playing = false; paint(); setState('tap ▶ to listen', ''); });
    }
    function stop(msg) {
      playing = false; cancelAnimationFrame(raf);
      au.pause(); au.removeAttribute('src'); au.load();
      jump.classList.add('hide'); paint(); setState(msg || 'Room audio', '');
    }
    play.addEventListener('click', function () { if (playing) { stop(); store('patvRoomAudio', 0); } else start(); });
    mute.addEventListener('click', function () { au.muted = !au.muted; store('patvRoomMuted', au.muted ? 1 : 0); paint(); });
    vol.addEventListener('input', function () { au.volume = vol.value / 100; if (au.volume > 0 && au.muted) au.muted = false; store('patvRoomVol', vol.value); paint(); });
    jump.addEventListener('click', function () { stop(); start(); });       // a fresh connection starts at live
    au.addEventListener('waiting', function () { if (playing) setState('LIVE · buffering…', 'wait'); });
    au.addEventListener('playing', function () { setState('LIVE', 'live'); });
    au.addEventListener('error', function () { if (playing) stop('audio stopped — ▶ to retry'); });
    setInterval(function () {
      if (!playing || !startedAt) return;
      var behind = (Date.now() - startedAt) / 1000 - au.currentTime;    // time lost to stalls
      jump.classList.toggle('hide', behind < 6);
      if (behind >= 6 && state.textContent === 'LIVE') setState('LIVE · catching up…', 'wait');
    }, 2000);
    paint();
    return {
      update: function (d) {
        var on = !!(d && d.room && d.room.audio);
        if (on === available) return;
        available = on;
        box.classList.toggle('hide', !on);
        if (!on) stop();
        else if (store('patvRoomAudio') === '1') setState('▶ to resume listening', '');
      },
    };
  }

  // ── chat relay box ──
  function relay(host, slug) {
    var form = el('form', 'rb-say hide'); form.setAttribute('autocomplete', 'off');
    var lab = el('label', 'rb-sr', 'Message to the room'); lab.htmlFor = 'rbSay' + slug;
    var inp = el('input'); inp.id = 'rbSay' + slug; inp.type = 'text'; inp.maxLength = 300; inp.required = true;
    inp.placeholder = 'Say something — Pepe relays it as “🌐 you (web)”';
    var btn = el('button', 'rb-btn rb-send', 'Send'); btn.type = 'submit';
    var mine = el('div', 'rb-mine'); mine.setAttribute('aria-live', 'polite');
    form.appendChild(lab); form.appendChild(inp); form.appendChild(btn);
    host.appendChild(form); host.appendChild(mine);
    var last = '';
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = inp.value.trim(); if (!text) return;
      btn.disabled = true;
      fetch('/api/rooms/' + encodeURIComponent(slug) + '/say', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d.ok) { inp.value = ''; mine.textContent = '💬 your message: waiting for Pepe…'; } else mine.textContent = '💬 ' + (d.error || 'not sent'); })
        .catch(function () { mine.textContent = '💬 couldn\'t reach the site'; })
        .then(function () { setTimeout(function () { btn.disabled = false; }, 3000); });
    });
    return {
      update: function (d) {
        form.classList.toggle('hide', !(d && d.room && d.room.relay));
        var js = (d && d.mine) || [], k = JSON.stringify(js);
        if (k === last) return;
        last = k;
        var j = js.filter(function (x) { return x.kind === 'say'; }).pop();
        if (j) mine.textContent = '💬 your message: ' + (j.state === 'done' ? (j.ok ? (j.msg || 'sent') : 'not sent — ' + (j.msg || 'refused')) : 'waiting for Pepe…');
      },
    };
  }

  window.PATVRoom = { audio: audio, relay: relay };
})();
