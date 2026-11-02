// av-sync.js — viewer-local cam and mic-sign timing while this pad's room audio is playing.
// The server ships this dark. Audio, source programs and moderation controls are never delayed here.
// Only current identities are rendered; history contains timing flags, never old display names.
(function () {
  'use strict';
  var W = window, D = document, own = Object.prototype.hasOwnProperty;
  var translate = typeof W.__t === 'function' ? W.__t : function (key, fallback) { return fallback; };
  var receivers = [], configs = Object.create(null), records = Object.create(null), lines = [], buttons = [], listeners = [];
  var padSource = '', sound = { slug: '', playing: false, mode: 'rtc', pc: null, ahead: null };
  var soundStats = { browser: null, rtt: null, ok: false }, audioPrevious = null, mp3Average = null, mp3At = 0;
  var enabled = true, epoch = 0, timer = null, pollTimer = null, viewTimer = null, busy = false, again = false, stopped = false, debugBox = null;
  var storageKey = 'patv.avsync.enabled', HISTORY_MS = 6000, OFF_POLL_MS = 60000, signedOut = false;
  try { enabled = W.localStorage.getItem(storageKey) !== '0'; } catch (e) { /* storage is optional */ }

  function number(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function bounded(v, lo, hi, fallback) { return number(v) == null ? fallback : clamp(v, lo, hi); }
  function copy(value) { var out = {}; Object.keys(value || {}).forEach(function (k) { out[k] = value[k]; }); return out; }
  function slug(v) { return typeof v === 'string' ? v : ''; }
  function defaultPad() { try { return slug(typeof padSource === 'function' ? padSource() : padSource); } catch (e) { return ''; } }
  function engine() {
    var n = W.navigator || {}, ua = n.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua) || (n.platform === 'MacIntel' && n.maxTouchPoints > 1)) return 'safari';
    if (/Firefox\//.test(ua)) return 'firefox';
    if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return 'chromium';
    return 'safari';
  }
  var browserEngine = engine();
  function pathOf(url) {
    // The query can contain a reader ticket. It is never stored, sent or included in debug output.
    var match = /\/whep\/([^/?#]+)/.exec(String(url || ''));
    if (!match) return null;
    try { var p = decodeURIComponent(match[1]); return /^[A-Za-z0-9._-]{1,200}$/.test(p) ? p : null; } catch (e) { return null; }
  }
  function delta(previous, current) {
    if (!previous || !current || previous.ids !== current.ids) return null;
    var count = current.count - previous.count, delay = current.delay - previous.delay;
    return count > 0 && delay >= 0 ? delay * 1000 / count : null;
  }
  function average(previous, value, elapsed) {
    if (number(value) == null || value < 0) return null;
    return number(previous) == null ? value : previous + (value - previous) * (1 - Math.exp(-Math.max(0, elapsed) / 10000));
  }
  function videoTarget(input) {
    var cap = bounded(input.cap, 0, 4000, 3000), value;
    if (!input.fresh || !input.statsOK || number(input.pepe) == null || number(input.hold) == null || number(input.browser) == null) value = bounded(input.fallback, 0, 4000, 0);
    else value = input.pepe - input.hold + (number(input.k) || 0) + input.browser + (number(input.net) || 0);
    value = clamp(value, 0, cap); return value > 0 ? value : null;
  }
  function indicatorTarget(input) {
    var value = !input.fresh || !input.statsOK || number(input.pepe) == null || number(input.browser) == null
      ? bounded(input.fallback, 0, 4000, 0) : input.pepe + input.browser + (number(input.k) || 0) - (number(input.path) || 0);
    return clamp(value, 0, bounded(input.cap, 0, 5000, 3000));
  }
  function cfgFor(pad) {
    var entry = configs[pad];
    return entry && entry.data && Date.now() - entry.at <= 30000 ? entry.data : null;
  }
  function ageOf(pad) {
    var entry = configs[pad], audio = entry && entry.data && entry.data.audio;
    return audio && number(audio.age_s) != null ? Math.max(0, audio.age_s + (Date.now() - entry.at) / 1000) : Infinity;
  }
  function eligible(pad, kind, ignoreToggle) {
    var c = cfgFor(pad);
    return !!(c && c.on && (enabled || ignoreToggle) && sound.playing && sound.slug === pad &&
      c.apply && c.apply[kind] && (sound.mode !== 'mp3' || c.apply.mp3) &&
      (kind !== 'video' || c.engines && c.engines[browserEngine]));
  }
  function inputs(pad) {
    var c = cfgFor(pad) || {}, a = c.audio || {};
    return { pepe: number(a[sound.mode + '_ms']), browser: soundStats.browser, fresh: ageOf(pad) <= 30,
      statsOK: soundStats.ok, fallback: c.fallback && c.fallback[sound.mode], cap: c.cap, k: 0 };
  }
  // 1.99??: kind = which switch holds the sign back - 'mic' (the mic stage's tile signs, the default), 'mic_card' (the "On the mic"
  // card) or 'mic_chat' (the chat's grab / drop lines). All three use the same mic-sign offset, so they line up with each other.
  var MIC_KINDS = ['mic', 'mic_card', 'mic_chat'];
  function anyMic(pad, ignoreToggle) { return MIC_KINDS.some(function (kind) { return eligible(pad, kind, ignoreToggle); }); }
  function delayFor(pad, ignoreToggle, kind) {
    if (!eligible(pad, kind || 'mic', ignoreToggle)) return 0;
    var c = cfgFor(pad), input = inputs(pad);
    input.k = c.k && c.k.ind; input.path = c.ind_path_ms; input.cap = c.cap_ind;
    return indicatorTarget(input);
  }
  function targetFor(entry, ignoreToggle) {
    if (!eligible(entry.pad, 'video', ignoreToggle)) return null;
    var c = cfgFor(entry.pad), cam = c.cams && c.cams[entry.path], input = inputs(entry.pad);
    input.hold = cam && number(cam.hold_ms); input.k = cam && c.k && c.k[cam.src === 'passthrough' || cam.src === 'pt' ? 'pt' : 're'];
    input.statsOK = input.statsOK && entry.statsOK;
    input.net = sound.mode === 'rtc' && number(soundStats.rtt) != null && number(entry.rtt) != null ? (soundStats.rtt - entry.rtt) * 500 : 0;
    return videoTarget(input);
  }
  function setTarget(entry, target, force) {
    target = number(target) == null || target <= 0 ? null : clamp(target, 0, 4000);
    var c = cfgFor(entry.pad), band = c ? bounded(c.deadband, 0, 500, 40) : 40;
    if (!force && entry.target !== undefined && (entry.target === target || target != null && entry.target != null && Math.abs(target - entry.target) <= band)) return;
    try {
      if ('jitterBufferTarget' in entry.receiver) entry.receiver.jitterBufferTarget = target;
      else if ('playoutDelayHint' in entry.receiver) entry.receiver.playoutDelayHint = target == null ? null : target / 1000;
      else { entry.supported = false; entry.target = null; return; }
      entry.supported = true; entry.target = target;
    } catch (e) { entry.supported = false; entry.target = null; }
  }
  function pruneReceivers() {
    receivers = receivers.filter(function (entry) {
      if (!entry.pc || entry.pc.signalingState === 'closed' || entry.pc.connectionState === 'closed') {
        setTarget(entry, null, true);
        if (entry.pc && entry.pc.removeEventListener && entry.closeListener) entry.pc.removeEventListener('connectionstatechange', entry.closeListener);
        return false;
      }
      return true;
    });
    Object.keys(configs).forEach(function (pad) {
      if (pad !== sound.slug && Date.now() - configs[pad].at > 60000 && !configs[pad].pending && !receivers.some(function (entry) { return entry.pad === pad; })) delete configs[pad];
    });
  }
  function readStats(pc, kind) {
    if (!pc || !pc.getStats || pc.signalingState === 'closed') return Promise.reject(new Error('No stats'));
    return within(Promise.resolve().then(function () { return pc.getStats(); }), 2500).then(function (report) {
      var inbound = [], selected = null, fallback = null, pairs = Object.create(null);
      report.forEach(function (row) {
        if (row.type === 'inbound-rtp' && !row.isRemote && (row.kind === kind || row.mediaType === kind)) inbound.push(row);
        if (row.type === 'transport' && row.selectedCandidatePairId) selected = row.selectedCandidatePairId;
        if (row.type === 'candidate-pair') { pairs[row.id] = row; if (row.nominated && row.state === 'succeeded') fallback = row; }
      });
      var pair = selected && pairs[selected] || fallback, result = { ids: [], count: 0, delay: 0, rtt: pair && number(pair.currentRoundTripTime), diagnostics: {} };
      inbound.forEach(function (row) {
        result.ids.push(String(row.id));
        if (number(row.jitterBufferDelay) != null && number(row.jitterBufferEmittedCount) != null) { result.delay += row.jitterBufferDelay; result.count += row.jitterBufferEmittedCount; }
        ['jitterBufferDelay', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay', 'jitterBufferEmittedCount', 'framesDropped', 'freezeCount', 'totalFreezesDuration'].forEach(function (key) {
          if (number(row[key]) != null) result.diagnostics[key] = (result.diagnostics[key] || 0) + row[key];
        });
      });
      result.ids = result.ids.sort().join(','); result.inbound = inbound.length; return result;
    });
  }
  function within(promise, ms) {
    return new Promise(function (resolve, reject) {
      var expired = setTimeout(function () { reject(new Error('Timing unavailable')); }, ms);
      promise.then(function (value) { clearTimeout(expired); resolve(value); }, function (error) { clearTimeout(expired); reject(error); });
    });
  }
  function fetchConfig(pad) {
    if (!pad || !W.fetch || signedOut) return Promise.resolve();
    var entry = configs[pad] || (configs[pad] = { data: null, at: 0, requested: -Infinity, force: true }), now = Date.now();
    // review fix: the page loads this only while the mode applies to the viewer. A page left open after the switch went
    // off asks once a minute (new cams don't force it), and a pad that refused this viewer is not asked again before a reload.
    var gap = entry.data && !entry.data.on ? OFF_POLL_MS : entry.force ? 0 : 5000;
    if (entry.pending || entry.denied || now - entry.requested < gap) return Promise.resolve();
    var paths = [];
    receivers.forEach(function (r) { if (r.pad === pad && r.path && paths.indexOf(r.path) < 0 && paths.length < 12) paths.push(r.path); });
    entry.force = false; entry.requested = now; entry.pending = true;
    return within(W.fetch('/api/rooms/' + encodeURIComponent(pad) + '/avsync?p=' + encodeURIComponent(paths.join(',')),
      { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch' } })
      .then(function (response) { if (!response.ok) { var error = new Error('Unavailable'); error.status = response.status; error.denied = response.status === 401 || response.status === 403; throw error; } return response.json(); }), 5000)
      .then(function (data) { entry.data = data && data.ok ? data : null; entry.at = Date.now(); })
      .catch(function (error) {
        if (error && error.denied) entry.data = null; /* Other failures cannot keep old settings alive beyond 30 seconds. */
        if (error && error.status === 401) signedOut = true;      // review fix: signed out - no pad is asked again before a reload
        if (error && error.status === 403) entry.denied = true;
      })
      .then(function () { entry.pending = false; });
  }
  function sampleAudio(generation) {
    if (!sound.playing) return Promise.resolve();
    if (sound.mode === 'mp3') {
      var value = null, now = Date.now();
      try { value = typeof sound.ahead === 'function' ? sound.ahead() : null; } catch (e) { /* buffer unknown */ }
      mp3Average = average(mp3Average, number(value) == null ? null : value * 1000, now - mp3At); mp3At = now;
      soundStats = { browser: mp3Average, rtt: null, ok: mp3Average != null }; return Promise.resolve();
    }
    return readStats(sound.pc, 'audio').then(function (stats) {
      if (generation !== epoch) return;
      var ms = delta(audioPrevious, stats); audioPrevious = stats;
      soundStats = { browser: ms, rtt: stats.rtt, ok: ms != null, diagnostics: stats.diagnostics };
    }, function () { if (generation === epoch) { audioPrevious = null; soundStats = { browser: null, rtt: null, ok: false }; } });
  }
  function tick() {
    if (stopped) return;
    clearTimeout(timer); timer = null;
    if (busy) { again = true; return; }
    busy = true; pruneReceivers(); var generation = epoch;
    // Clear ineligible receivers before any asynchronous work, including a pending fetch.
    receivers.forEach(function (entry) { if (!eligible(entry.pad, 'video')) setTarget(entry, null); });
    (sound.playing ? fetchConfig(sound.slug) : Promise.resolve()).then(function () {
      if (generation !== epoch || !anyMic(sound.slug) && !eligible(sound.slug, 'video')) return;   // 1.99??: any of the mic switches
      var tasks = [sampleAudio(generation)];
      receivers.forEach(function (entry) {
        if (!eligible(entry.pad, 'video')) return;
        tasks.push(readStats(entry.pc, 'video').then(function (stats) {
          if (generation !== epoch || receivers.indexOf(entry) < 0) return;
          entry.statsOK = stats.inbound > 0; entry.rtt = stats.rtt; entry.diagnostics = stats.diagnostics;
        }, function () { if (generation === epoch) { entry.statsOK = false; entry.rtt = null; entry.diagnostics = {}; } }));
      });
      return Promise.all(tasks);
    }).then(function () {
      if (generation === epoch) { pruneReceivers(); receivers.forEach(function (entry) { setTarget(entry, targetFor(entry)); }); refreshViews(); notify(); }
    }).catch(function () { /* Optional timing must never break playback. */ }).then(function () {
      busy = false;
      if (stopped) return;
      var c = cfgFor(sound.slug), period = c ? bounded(c.period_s, 1, 10, 2) * 1000 : 2000;
      if (again) { again = false; timer = setTimeout(tick, 0); } else timer = setTimeout(tick, period);
    });
  }
  function poll() {
    pollTimer = null; if (stopped) return;
    var generation = epoch;
    (sound.playing ? fetchConfig(sound.slug) : Promise.resolve()).then(function () {
      if (generation === epoch) { receivers.forEach(function (entry) { setTarget(entry, targetFor(entry)); }); refreshViews(); notify(); }
      if (!stopped) pollTimer = setTimeout(poll, 5000);
    });
  }
  function wake() { clearTimeout(timer); timer = setTimeout(tick, 0); if (!pollTimer) pollTimer = setTimeout(poll, 5000); }
  function video(receiver, options) {
    options = options || {}; if (!receiver || !options.pc) return;
    pruneReceivers(); var existing = receivers.filter(function (r) { return r.receiver === receiver; })[0];
    if (existing) return;
    var pad = slug(options.pad) || defaultPad(), path = pathOf(options.url);
    var entry = { receiver: receiver, pc: options.pc, pad: pad, path: path, target: undefined, rtt: null, diagnostics: {}, statsOK: true, supported: false };
    receivers.push(entry);
    entry.closeListener = function () { pruneReceivers(); };
    if (entry.pc.addEventListener) entry.pc.addEventListener('connectionstatechange', entry.closeListener);
    // This synchronous write precedes watch() assigning srcObject. A known path uses its last valid target.
    var sibling = receivers.filter(function (r) { return r !== entry && r.pad === pad && r.path === path && r.target != null; })[0];
    if (sibling) { entry.statsOK = sibling.statsOK; entry.rtt = sibling.rtt; }
    setTarget(entry, targetFor(entry), true);
    if (pad) { if (!configs[pad]) configs[pad] = { data: null, at: 0, requested: -Infinity }; configs[pad].force = true; }
    wake();
  }
  function audio(value) {
    value = value || {}; var nextPad = slug(value.slug), playing = value.playing === true, mode = value.mode === 'mp3' ? 'mp3' : 'rtc', pc = value.pc || null;
    // An old player's asynchronous pause must not silence the newly selected pad's controller.
    if (!playing && sound.playing && nextPad !== sound.slug) return;
    var changed = nextPad !== sound.slug || mode !== sound.mode || pc !== sound.pc || playing !== sound.playing;
    sound = { slug: nextPad, playing: playing, mode: mode, pc: pc, ahead: value.ahead || null };
    if (changed) { epoch++; audioPrevious = null; mp3Average = null; mp3At = 0; soundStats = { browser: null, rtt: null, ok: false }; }
    receivers.forEach(function (entry) { if (!eligible(entry.pad, 'video')) setTarget(entry, null, true); });
    refreshViews(); notify(); wake();
  }
  function latency(pad, mode) {
    if (!sound.playing || sound.slug !== pad || sound.mode !== mode || !soundStats.ok || ageOf(pad) > 30) return null;
    var c = cfgFor(pad), p = c && c.audio && number(c.audio[mode + '_ms']);
    return p == null || number(soundStats.browser) == null ? null : Math.max(0, p + soundStats.browser);
  }
  function modsInstant(pad) { var c = cfgFor(pad); return !!(c && c.mods_instant); }

  // Mic histories retain keys and timing flags only. Every label, permission and person comes from the newest data.
  function personKey(person, index, group) {
    if (!person || typeof person !== 'object') return '';
    if (person.anon || person.anonymous) return typeof person.id === 'string' ? 'anonymous:' + person.id : 'anonymous-group:' + group + ':' + index;
    if (typeof person.id === 'string') return 'id:' + person.id;
    if (typeof person.login === 'string' && person.login) return 'login:' + person.login.toLowerCase();
    return person.self ? 'self' : '';
  }
  function visitPeople(people, group, callback) {
    var anonymous = 0;
    (people || []).forEach(function (person, index) {
      var keyless = person && (person.anon || person.anonymous) && typeof person.id !== 'string';
      var ordinal = keyless ? anonymous++ : index;
      callback(person, personKey(person, ordinal, group), keyless, ordinal);
    });
  }
  function tileKey(tile) { return tile && typeof tile.id === 'string' ? (tile.anon ? 'anonymous:' : 'tile:') + tile.id : ''; }
  function historyRecord(kind, pad, latest, callback) {
    var key = kind + ':' + pad, record = records[key], now = Date.now();
    if (!record) record = records[key] = { kind: kind, pad: pad, rows: [], births: Object.create(null), latest: null, signature: null, touched: now };
    record.latest = latest; record.callback = callback; record.touched = now;
    var compact, present = Object.create(null);
    if (kind === 'program') {
      compact = { src: [], count: 0, active: false, layout: null, dyn: null, speaking: null, override: null, fixed: false };
      if (latest) {
        if (latest.speaking === 'pepe') record.pepeAt = now;
        // (wave2 WP-4: `ring` - every current holder in the dynamic layout - is delayed like newest / recent)
        (latest.src || []).forEach(function (tile) { var k = tileKey(tile); if (!k) return; present[k] = true; if (!own.call(record.births, k)) record.births[k] = now; compact.src.push({ key: k, newest: tile.newest, recent: tile.recent, ring: tile.ring }); });
        compact.count = latest.count; compact.active = latest.active; compact.layout = latest.layout; compact.dyn = latest.dyn; compact.speaking = latest.speaking;
        compact.override = latest.manage && latest.manage.layout_override; compact.fixed = latest.fixed;
      }
      Object.keys(record.births).forEach(function (k) { if (!present[k]) delete record.births[k]; });
    } else {
      // 1.99??: review fix (T1, T2) - no onset times any more: the card shows a turn from its grab + the offset to its drop + the offset
      compact = { mic: [], on: Object.create(null) };
      visitPeople(latest && latest.mic, 'mic', function (person, k) { if (k) { compact.mic.push(k); compact.on[k] = true; } });
      visitPeople(latest && latest.members, 'members', function (person, k) { if (k && person.on_mic) compact.on[k] = true; });
    }
    var signature = JSON.stringify(compact);
    if (!record.rows.length || record.rows[record.rows.length - 1].signature !== signature) record.rows.push({ at: now, data: compact, signature: signature });
    trimHistory(record, now); return record;
  }
  function trimHistory(record, now) {
    while (record.rows.length > 1 && record.rows[1].at < now - HISTORY_MS) record.rows.shift();
    if (record.rows.length > 256) record.rows.splice(0, record.rows.length - 256);
  }
  function oldRow(record, target) {
    for (var i = record.rows.length - 1; i >= 0; i--) if (record.rows[i].at <= target) return record.rows[i];
    return null;
  }
  // review fix: the moment a view shows never moves back. When D rises (RTC fallback -> measured, audio starting again)
  // the view holds until now - D catches up, as the cams' growing buffer does, so tiles and people already on screen are
  // never pulled and re-added (each tile pulled also reconnected its cam). Removals and veil changes stay immediate: the
  // newest data has no such key any more.
  function shownAt(record, wait, now) {
    var at = Math.max(now - wait, record.shownAt == null ? -Infinity : record.shownAt);
    record.shownAt = at; return at;
  }
  function mergedProgram(record, wait, now) {
    var latest = record.latest; if (!latest) return latest;
    if (!wait) { record.shownAt = now; return latest; }
    var at = shownAt(record, wait, now), out = copy(latest), row = oldRow(record, at), old = row && row.data, oldTiles = Object.create(null);
    (old && old.src || []).forEach(function (tile) { oldTiles[tile.key] = tile; });
    out.src = (latest.src || []).filter(function (tile) { var k = tileKey(tile); return tile.pin || k && record.births[k] <= at; }).map(function (tile) {
      var t = copy(tile), previous = oldTiles[tileKey(tile)]; t.newest = !!(previous && previous.newest); t.recent = !!(previous && previous.recent);
      if (previous && previous.ring) t.ring = true; else delete t.ring;
      return t;
    });
    out.count = old ? old.count : 0; out.active = old ? old.active : false;
    out.speaking = latest.speaking === 'pepe' ? 'pepe' : old && old.speaking === 'someone' && (record.pepeAt == null || row.at >= record.pepeAt) ? 'someone' : null;
    var override = latest.manage && latest.manage.layout_override;
    if (old && old.override === override && old.fixed === latest.fixed) { out.layout = old.layout; if (own.call(latest, 'dyn')) out.dyn = old.dyn; }
    return out;
  }
  // 1.99??: review fix (T1, T2) - the card is held back, never thinned: whoever was on the mic at the moment the view shows (now - the
  // offset) is on it. The old minimum-hold rule (a turn shorter than the offset never showed) dropped a turn already on screen early
  // when the offset rose - before its "dropped the mic" line and before the viewer heard it end - and hid short turns whose grab and
  // drop lines the chat does show.
  function onAt(row, key) { return !!(row && row.data.on[key]); }
  function mergedMic(record, wait, now) {
    var latest = record.latest; if (!latest) return latest;
    if (!wait) { record.shownAt = now; return latest; }
    var at = shownAt(record, wait, now), out = copy(latest), row = oldRow(record, at), people = Object.create(null);
    visitPeople(latest.members, 'members', function (person, k, keyless, ordinal) {
      if (k) people[k] = person;
      // Today's public anonymous records have no stable ID. Retain only a generic mic count,
      // bounded by anonymous entries still in the newest room; never infer roster mic flags
      // from mic-array positions. WP-2's stable anonymous IDs enable exact cross-list timing.
      if (keyless) people['anonymous-group:mic:' + ordinal] = person;
    });
    visitPeople(latest.mic, 'mic', function (person, k) { if (k) people[k] = person; });
    out.members = [];
    visitPeople(latest.members, 'members', function (person, k) { var p = copy(person); p.on_mic = onAt(row, k); out.members.push(p); });
    out.mic = (row && row.data.mic || []).filter(function (k) { return own.call(people, k); }).map(function (k) { var p = copy(people[k]); p.on_mic = true; return p; });
    return out;
  }
  // 1.99??: the mic stage's program follows "Delay mic signs"; the "On the mic" card's view (micView) follows its own switch
  function switchOf(record) { return record.kind === 'program' ? 'mic' : 'mic_card'; }
  function renderRecord(record, call) {
    var wait = delayFor(record.pad, false, switchOf(record)), now = Date.now(), out = record.kind === 'program' ? mergedProgram(record, wait, now) : mergedMic(record, wait, now);
    var signature = JSON.stringify(out), changed = signature !== record.signature; record.signature = signature;
    if (call && changed && typeof record.callback === 'function') { try { record.callback(out); } catch (e) { /* isolate optional rendering */ } }
    return out;
  }
  function scheduleViews() {
    clearTimeout(viewTimer); viewTimer = null; if (stopped) return;
    var now = Date.now(), due = Infinity;
    Object.keys(records).forEach(function (key) {
      var record = records[key], wait = delayFor(record.pad, false, switchOf(record));
      if (now - record.touched > 60000 && record.pad !== defaultPad() && record.pad !== sound.slug) { delete records[key]; return; }
      trimHistory(record, now);
      if (wait) record.rows.forEach(function (row) { var at = row.at + wait; if (at > now) due = Math.min(due, at); });
    });
    // 1.99??: a held chat line is shown once the room audio has caught up to it ("Delay mic grab/drop lines in chat"); the delay is
    // read again each time, so stopping the audio, the switch going off or the viewer's own toggle shows every held line at once
    lines = lines.filter(function (line) {
      if (line.el.isConnected === false) { release(line); return false; }      // taken out by the page (privacy, trims): nothing to show
      var at = line.at + delayFor(line.pad, false, 'mic_chat');
      if (at <= now) { release(line); return false; }
      due = Math.min(due, at); return true;
    });
    if (due !== Infinity) viewTimer = setTimeout(refreshViews, Math.max(1, Math.ceil(due - now)));
  }
  /** 1.99??: show a held line where it already sits (its true place in the log); the page's reveal(el, show) keeps a reader who was
   *  at the bottom there. It is always shown, whatever reveal does. */
  function release(line) {
    var el = line.el, done = false, show = function () { if (!done) { done = true; el.style.display = line.display; } };
    delete el._patvAvSyncHeld;
    if (line.reveal && el.isConnected !== false) { try { line.reveal(el, show); } catch (e) { /* the line still shows */ } }
    show();
  }
  /** 1.99??: the viewer leaves, the tab is hidden or frozen - every held line shows at once (never lost while timers sleep). */
  function releaseLines() { var held = lines; lines = []; held.forEach(release); }
  function refreshViews() { Object.keys(records).forEach(function (key) { renderRecord(records[key], true); }); scheduleViews(); }
  function gateProgram(pad, program, callback) {
    var record = historyRecord('program', slug(pad), program, callback), out = renderRecord(record, false);
    if (typeof callback === 'function') callback(out); scheduleViews(); return out;
  }
  // C2 helpers. 1.99??: wired - the pad page's and the homepage panel's "On the mic" card (micView, the apply_mic_card switch) and
  // their chat's grab / drop lines (holdLine, apply_mic_chat). With the switch off, or sync not applying to this viewer, micView hands
  // back the data it was given and holdLine holds nothing.
  function micView(pad, data, rerender) { var record = historyRecord('mic', slug(pad), data, rerender), out = renderRecord(record, false); scheduleViews(); return out; }
  /** Hold a live grab / drop line the page has just put in its place in the log; -> true when held. The line keeps its place (hidden),
   *  so it shows in its true time order. Only a timing flag is kept on it - never who it names. */
  function holdLine(pad, element, reveal) {
    // 1.99??: a hidden tab shows lines as they come (its timers sleep); a line not in the page yet is never held (it could not be shown)
    if (!element || !element.style || element._patvAvSyncHeld || element.isConnected === false || D.hidden || !delayFor(pad, false, 'mic_chat')) return false;
    var line = { pad: slug(pad), el: element, at: Date.now(), display: element.style.display || '', reveal: typeof reveal === 'function' ? reveal : null };
    element._patvAvSyncHeld = true; element.style.display = 'none'; lines.push(line);
    if (lines.length > 600) release(lines.shift());
    scheduleViews(); return true;
  }
  function debug() {
    var c = cfgFor(sound.slug), a = c && c.audio || {};
    return { on: !!(c && c.on), enabled: enabled, playing: sound.playing, mode: sound.mode, engine: browserEngine,
      calibration: { pt_ms: c && c.k ? number(c.k.pt) : null, re_ms: c && c.k ? number(c.k.re) : null, ind_ms: c && c.k ? number(c.k.ind) : null,
        ind_path_ms: c ? number(c.ind_path_ms) : null, cap_ms: c ? number(c.cap) : null, cap_ind_ms: c ? number(c.cap_ind) : null,
        fallback_ms: c && c.fallback ? number(c.fallback[sound.mode]) : null, deadband_ms: c ? number(c.deadband) : null, period_s: c ? number(c.period_s) : null },
      audio: { pepe_ms: number(a[sound.mode + '_ms']), mix_ms: number(a.mix_ms), helper_ms: number(a.helper_ms), age_s: isFinite(ageOf(sound.slug)) ? ageOf(sound.slug) : null,
        browser_ms: number(soundStats.browser), stats_ok: soundStats.ok, rtt_s: number(soundStats.rtt) }, indicator_ms: delayFor(sound.slug),
      card_ms: delayFor(sound.slug, false, 'mic_card'), chat_ms: delayFor(sound.slug, false, 'mic_chat'),   // 1.99??
      tiles: receivers.map(function (entry, index) { var cam = c && c.cams && c.cams[entry.path]; return { slot: index + 1, same_pad: entry.pad === sound.slug,
        hold_ms: cam ? number(cam.hold_ms) : null, src: cam && ['passthrough', 'pt', 'reencode'].indexOf(cam.src) >= 0 ? cam.src : null,
        target_ms: number(entry.target), supported: entry.supported, rtt_s: number(entry.rtt), stats: copy(entry.diagnostics),
        playout_delay_extension: !!(entry.pc.remoteDescription && /a=extmap:[^\r\n]*playout-delay/.test(entry.pc.remoteDescription.sdp || '')) }; }) };
  }
  function notify() {
    // (1.99??: the viewer's toggle is offered while any of the mic switches holds something back too)
    var available = MIC_KINDS.some(function (kind) { return delayFor(sound.slug, true, kind) > 0; }) || receivers.some(function (entry) { return targetFor(entry, true) != null; });
    buttons = buttons.filter(function (item) { if (item.box.isConnected === false) return false; item.button.hidden = !available; item.button.setAttribute('aria-pressed', enabled ? 'true' : 'false'); return true; });
    var c = cfgFor(sound.slug), wantsDebug = /(?:^|[?&])avsync=1(?:&|$)/.test(W.location && W.location.search || '');
    if (wantsDebug && c && c.dbg && D.body) {
      if (!debugBox) {
        var panel = D.createElement('aside'), title = D.createElement('strong'), content = D.createElement('pre'), button = D.createElement('button');
        panel.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:9999;max-width:420px;max-height:45vh;overflow:auto;background:#10212a;color:#eef5f4;padding:12px;border:1px solid #758b92;font-size:12px';
        title.textContent = translate('js.pad.audio.avsync_debug', 'A/V sync measurements'); button.textContent = translate('js.pad.audio.avsync_copy', 'Copy measurements');
        button.type = 'button'; button.style.minHeight = '44px'; button.addEventListener('click', function () { try { if (W.navigator.clipboard) W.navigator.clipboard.writeText(JSON.stringify(debug(), null, 2)).catch(function () {}); } catch (e) {} });
        panel.appendChild(title); panel.appendChild(button); panel.appendChild(content); D.body.appendChild(panel); debugBox = { panel: panel, content: content };
      }
      debugBox.panel.hidden = false; debugBox.content.textContent = JSON.stringify(debug(), null, 2);
    } else if (debugBox) debugBox.panel.hidden = true;
    listeners.slice().forEach(function (listener) { try { listener(); } catch (e) {} });
  }
  function setEnabled(value) {
    enabled = value === true; epoch++;
    try { W.localStorage.setItem(storageKey, enabled ? '1' : '0'); } catch (e) {}
    receivers.forEach(function (entry) { setTarget(entry, targetFor(entry), true); }); refreshViews(); notify(); wake();
  }
  function decorate(box) {
    if (!box || buttons.some(function (item) { return item.box === box; })) return;
    var button = D.createElement('button'); button.type = 'button'; button.className = 'rb-btn'; button.hidden = true;
    button.style.minHeight = '44px'; button.style.minWidth = '44px'; button.textContent = translate('js.pad.audio.sync_cams', 'Sync cams to the audio');
    button.setAttribute('aria-pressed', enabled ? 'true' : 'false'); button.addEventListener('click', function () { setEnabled(!enabled); });
    box.appendChild(button); buttons.push({ box: box, button: button }); notify();
  }
  function onChange(callback) { if (typeof callback !== 'function') return function () {}; listeners.push(callback); return function () { listeners = listeners.filter(function (f) { return f !== callback; }); }; }
  W.PATVAvSync = { pad: function (value) { padSource = value; wake(); }, video: video, audio: audio, decorate: decorate, debug: debug,
    latency: latency, modsInstant: modsInstant, onChange: onChange, gateProgram: gateProgram, micView: micView, holdLine: holdLine,
    _math: { videoTarget: videoTarget, indicatorTarget: indicatorTarget, delta: delta, average: average, pathOf: pathOf } };
  if (W.addEventListener) {
    W.addEventListener('storage', function (event) { if (event.key === storageKey) setEnabled(event.newValue !== '0'); });
    W.addEventListener('pagehide', function () { stopped = true; epoch++; clearTimeout(timer); clearTimeout(pollTimer); pollTimer = null; clearTimeout(viewTimer); receivers.forEach(function (r) { setTarget(r, null, true); }); releaseLines(); });
    W.addEventListener('pageshow', function () { if (stopped) { stopped = false; wake(); } });
  }
  // 1.99??: a hidden or frozen tab's timers sleep - its held chat lines show at once; back in view, the card is drawn as it is now
  if (D.addEventListener) {
    D.addEventListener('visibilitychange', function () { if (D.hidden) releaseLines(); else if (!stopped) refreshViews(); });
    D.addEventListener('freeze', releaseLines);
  }
})();
