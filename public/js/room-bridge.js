// room-bridge.js — shared pieces of the Camfrog room bridge UI, used by the room page (views/room.ejs)
// and the homepage's live room panel (views/home.ejs):
//   PATVRoom.audio(el, slug)   mini player for the room's live audio (play/pause, volume + mute,
//                              live / buffering state, jump to live, level meter)
//   PATVRoom.relay(el, slug)   the "say something" box (Pepe relays it into the room as "🌐 you (web)");
//                              a "!" line is a command Pepe runs as your Camfrog name (autocomplete + your private answers)
//   PATVRoom.ptt(el, slug)     hold-to-talk: a voice clip (20 s max) Pepe plays on the room's mic when
//                              it's free; shown only while the room's bridge_mic switch is on
// All are driven by the live view JSON: call .update(d) with each poll result.
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
      var n = bars.length, span = Math.max(1, Math.floor(d.length / n));
      for (var i = 0; i < n; i++) {
        var v = 0; for (var k = i * span; k < (i + 1) * span && k < d.length; k++) v = Math.max(v, d[k]);
        bars[i].style.height = Math.max(2, Math.round(v / 255 * 14)) + 'px';
      }
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
    // The room arrives in ~1 s pieces in real time, so playing the moment the first bytes land means
    // stuttering forever. Fill a small cushion first (CUSHION s of audio, or give up waiting after
    // 20 s and play what there is), then play.
    var CUSHION = 2.5, waitTimer = null;
    function ahead() { var b = au.buffered; return b.length ? b.end(b.length - 1) - au.currentTime : 0; }
    function start() {
      clearInterval(waitTimer);
      au.preload = 'auto';
      au.src = '/rooms/' + encodeURIComponent(slug) + '/audio?t=' + Date.now();
      au.load();
      wireMeter();
      if (actx && actx.state === 'suspended') actx.resume();
      playing = true; paint(); store('patvRoomAudio', 1);
      setState('connecting…', 'wait');
      var t0 = Date.now(), lastGot = 0, grewAt = Date.now();
      waitTimer = setInterval(function () {
        if (!playing) { clearInterval(waitTimer); return; }
        var got = ahead();
        if (got > 0.2) setState('buffering ' + Math.min(100, Math.round(got / CUSHION * 100)) + '%', 'wait');
        // a paused element stops fetching after a couple of seconds - so "it stopped growing" counts as full too
        if (got > lastGot + 0.05) { lastGot = got; grewAt = Date.now(); }
        var full = got >= CUSHION || (got > 0.8 && Date.now() - grewAt > 1500);
        if (!full && Date.now() - t0 < 20000) return;
        clearInterval(waitTimer);
        if (got <= 0) { stop('no audio from the room right now — ▶ to retry'); return; }
        au.play().then(function () { startedAt = Date.now() - au.currentTime * 1000; meterLoop(); })
          .catch(function () { playing = false; paint(); setState('tap ▶ to listen', ''); });
      }, 250);
    }
    function stop(msg) {
      playing = false; cancelAnimationFrame(raf); clearInterval(waitTimer);
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
    box.rbDebug = function () {                 // for diagnosing "I can't hear it" from the console
      var lvl = null;
      if (analyser) { var d = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(d); lvl = Math.max.apply(null, d); }
      return { ctx: actx ? actx.state : null, meter: !!analyser, level: lvl, t: au.currentTime, ahead: ahead(), muted: au.muted, volume: au.volume };
    };
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
  // A line starting with "!" is a command: Pepe runs it in the room as your linked Camfrog name, with
  // the same permissions and prices as typing it there (1.99). Typing "!" opens a list of the room's
  // allowed commands (with prices); "!commands" lists them all. Answers Pepe would have PM'd show
  // here, for you only; public answers land in the room feed.
  function relay(host, slug) {
    var form = el('form', 'rb-say hide'); form.setAttribute('autocomplete', 'off');
    var lab = el('label', 'rb-sr', 'Message or !command to the room'); lab.htmlFor = 'rbSay' + slug;
    var wrap = el('div', 'rb-say-in');
    var inp = el('input'); inp.id = 'rbSay' + slug; inp.type = 'text'; inp.maxLength = 300; inp.required = true;
    inp.placeholder = 'Say something — Pepe relays it as “🌐 you (web)”';
    inp.setAttribute('role', 'combobox'); inp.setAttribute('aria-autocomplete', 'list'); inp.setAttribute('aria-expanded', 'false');
    var list = el('ul', 'rb-ac hide'); list.id = 'rbAc' + slug; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Commands');
    inp.setAttribute('aria-controls', list.id);
    wrap.appendChild(inp); wrap.appendChild(list);
    var btn = el('button', 'rb-btn rb-send', 'Send'); btn.type = 'submit';
    var hint = el('div', 'rb-hint hide', 'Type !commands to see what you can run here as your Camfrog name.');
    var mine = el('div', 'rb-mine'); mine.setAttribute('aria-live', 'polite');
    var feed = el('ul', 'rb-cmdfeed'); feed.setAttribute('aria-live', 'polite'); feed.setAttribute('aria-label', 'Your commands');
    form.appendChild(lab); form.appendChild(wrap); form.appendChild(btn);
    host.appendChild(form); host.appendChild(hint); host.appendChild(mine); host.appendChild(feed);
    var last = '', lastJs = [], cmds = null, local = [], acIdx = -1, acItems = [];

    function fmtPrice(n) { return n > 0 ? Number(n).toLocaleString('en-US') + ' PAT' : ''; }
    function closeAc() { list.classList.add('hide'); list.textContent = ''; acItems = []; acIdx = -1; inp.setAttribute('aria-expanded', 'false'); inp.removeAttribute('aria-activedescendant'); }
    function pick(c) { inp.value = c + ' '; closeAc(); inp.focus(); }
    function paintAc() {
      acItems.forEach(function (li, i) {
        var on = i === acIdx; li.classList.toggle('on', on); li.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) { inp.setAttribute('aria-activedescendant', li.id); if (li.scrollIntoView) li.scrollIntoView({ block: 'nearest' }); }
      });
    }
    function openAc() {
      var v = inp.value;
      if (!cmds || v.charAt(0) !== '!' || /\s/.test(v)) { closeAc(); return; }
      var q = v.toLowerCase();
      var names = Object.keys(cmds).concat(['!commands']).filter(function (c) { return c.indexOf(q) === 0; }).sort();
      // cheap ones first in the list's natural order; just cap it
      names = names.slice(0, 8);
      list.textContent = ''; acItems = [];
      if (!names.length || (names.length === 1 && names[0] === q)) { closeAc(); return; }
      names.forEach(function (c, i) {
        var li = el('li', 'rb-ac-it'); li.id = list.id + '-' + i; li.setAttribute('role', 'option');
        li.appendChild(el('span', 'rb-ac-c', c));
        var p = c === '!commands' ? 'list them all' : fmtPrice(cmds[c]);
        if (p) li.appendChild(el('span', 'rb-ac-p', p));
        li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(c); });
        list.appendChild(li); acItems.push(li);
      });
      acIdx = -1; list.classList.remove('hide'); inp.setAttribute('aria-expanded', 'true'); paintAc();
    }
    inp.addEventListener('input', openAc);
    inp.addEventListener('blur', function () { setTimeout(closeAc, 100); });
    inp.addEventListener('keydown', function (e) {
      if (list.classList.contains('hide') || !acItems.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); acIdx = (acIdx + 1) % acItems.length; paintAc(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); acIdx = acIdx <= 0 ? acItems.length - 1 : acIdx - 1; paintAc(); }
      else if ((e.key === 'Enter' || e.key === 'Tab') && acIdx >= 0) { e.preventDefault(); pick(acItems[acIdx].firstChild.textContent); }
      else if (e.key === 'Escape') { closeAc(); }
    });

    function renderFeed(js) {
      feed.textContent = '';
      var rows = local.concat(js.filter(function (x) { return x.kind === 'cmd'; }).map(function (j) {
        var st = j.state !== 'done' ? 'waiting for Pepe…' : (j.ok ? (j.replies && j.replies.length ? '' : (j.msg || 'done')) : 'not run — ' + (j.msg || 'refused'));
        return { at: j.at, text: j.text, st: st, ok: j.state === 'done' ? j.ok : null, replies: j.replies || [] };
      })).sort(function (a, b) { return a.at - b.at; }).slice(-4);
      rows.forEach(function (r) {
        var li = el('li', 'rb-cmd' + (r.ok === false ? ' bad' : ''));
        var head = el('div', 'rb-cmd-h');
        head.appendChild(el('span', 'rb-cmd-t', '› ' + r.text));
        if (r.st) head.appendChild(el('span', 'rb-cmd-s', r.st));
        li.appendChild(head);
        r.replies.forEach(function (t) { li.appendChild(el('div', 'rb-cmd-r', '🔒 ' + t)); });
        feed.appendChild(li);
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      closeAc();
      var text = inp.value.trim(); if (!text) return;
      var isCmd = text.charAt(0) === '!';
      btn.disabled = true;
      fetch('/api/rooms/' + encodeURIComponent(slug) + '/say', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ text: text }) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.ok && d.local) { inp.value = ''; local.push({ at: Date.now(), text: text, st: '', ok: true, replies: [d.reply || ''] }); local = local.slice(-2); renderFeed(lastJs); return; }
          if (d.ok) { inp.value = ''; if (!isCmd) mine.textContent = '💬 your message: waiting for Pepe…'; return; }
          if (isCmd) { local.push({ at: Date.now(), text: text, st: 'not sent — ' + (d.error || 'refused'), ok: false, replies: [] }); local = local.slice(-2); renderFeed(lastJs); }
          else mine.textContent = '💬 ' + (d.error || 'not sent');
        })
        .catch(function () { mine.textContent = '💬 couldn\'t reach the site'; })
        .then(function () { setTimeout(function () { btn.disabled = false; }, isCmd ? 1500 : 3000); });
    });
    return {
      update: function (d) {
        form.classList.toggle('hide', !(d && d.room && d.room.relay));
        cmds = d && d.room && d.room.cmds ? d.room.cmds : null;
        hint.classList.toggle('hide', !(cmds && d.room.relay));
        inp.placeholder = cmds ? 'Say something, or type ! for commands — relayed as “🌐 you (web)”' : 'Say something — Pepe relays it as “🌐 you (web)”';
        var js = (d && d.mine) || [], k = JSON.stringify(js);
        lastJs = js;
        if (k === last) return;
        last = k;
        var j = js.filter(function (x) { return x.kind === 'say'; }).pop();
        if (j) mine.textContent = '💬 your message: ' + (j.state === 'done' ? (j.ok ? (j.msg || 'sent') : 'not sent — ' + (j.msg || 'refused')) : 'waiting for Pepe…');
        renderFeed(js);
      },
    };
  }

  // ── push-to-talk clip: hold the button (or click to start, click again to stop); 20 s max ──
  function ptt(host, slug) {
    var box = el('div', 'rb-ptt hide');
    var btn = el('button', 'rb-btn rb-talk', '🎙 Hold to talk'); btn.type = 'button'; btn.setAttribute('aria-pressed', 'false');
    var txt = el('span', 'rb-ptt-txt', 'up to 20 s · Pepe plays it on the mic when it\'s free');
    txt.setAttribute('aria-live', 'polite');
    var mine = el('div', 'rb-mine'); mine.setAttribute('aria-live', 'polite');
    box.appendChild(btn); box.appendChild(txt);
    host.appendChild(box); host.appendChild(mine);
    var can = !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    var rec = null, chunks = [], recAt = 0, recTimer = null, held = false, last = '';
    function stop() { if (rec && rec.state === 'recording') rec.stop(); clearTimeout(recTimer); }
    function start() {
      if (rec && rec.state === 'recording') return stop();
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        var type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'].filter(function (t) { return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t); })[0] || '';
        rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
        chunks = []; recAt = Date.now();
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          btn.setAttribute('aria-pressed', 'false'); btn.textContent = '🎙 Hold to talk';
          var secs = (Date.now() - recAt) / 1000;
          if (secs < 0.7) { txt.textContent = 'too short — hold the button while you talk'; return; }
          var blob = new Blob(chunks, { type: (rec.mimeType || 'audio/webm').split(';')[0] });
          txt.textContent = 'sending ' + secs.toFixed(0) + 's…';
          fetch('/api/rooms/' + encodeURIComponent(slug) + '/clip', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': blob.type, 'x-clip-secs': secs.toFixed(1) }, body: blob })
            .then(function (r) { return r.json(); })
            .then(function (d) { txt.textContent = d.ok ? 'sent — Pepe plays it when the mic is free' : (d.error || 'not sent'); })
            .catch(function () { txt.textContent = 'couldn\'t reach the site'; });
        };
        rec.start(250);
        btn.setAttribute('aria-pressed', 'true'); btn.textContent = '⏺ Recording — release to send';
        recTimer = setTimeout(stop, 20000);
      }).catch(function () { txt.textContent = 'the browser didn\'t allow the microphone'; });
    }
    btn.addEventListener('pointerdown', function (e) { e.preventDefault(); held = true; start(); });
    btn.addEventListener('pointerup', function () { if (held && Date.now() - recAt > 400) stop(); held = false; });
    btn.addEventListener('pointerleave', function () { if (held) stop(); held = false; });
    btn.addEventListener('keydown', function (e) { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); start(); } });
    return {
      update: function (d) {
        var on = !!(d && d.room && d.room.micRelay) && can;
        box.classList.toggle('hide', !on);
        if (!on) stop();
        var js = (d && d.mine) || [], k = JSON.stringify(js);
        if (k === last) return;
        last = k;
        var j = js.filter(function (x) { return x.kind === 'clip'; }).pop();
        mine.textContent = !j ? '' : '🎙 your clip: ' +
          (j.state === 'done' ? (j.ok ? (j.msg || 'sent') : 'not sent — ' + (j.msg || 'refused')) : 'waiting for Pepe…');
      },
    };
  }

  window.PATVRoom = { audio: audio, relay: relay, ptt: ptt };
})();
