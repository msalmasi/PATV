// feed-composer.js — the post composer (moved out of feed.js in 1.99bz) and the /feed page's
// in-place list switching.
//
// Composer: chunked uploads, link preview, price, plus (1.99bz)
//   * the draft (title, text, link, NSFW, destinations, finished uploads) is autosaved per user in
//     localStorage and restored on the next visit; it's cleared once the post is made
//   * (1.99ci) exactly ONE community per post, picked from a searchable list (no main feed, no
//     multi-select - Crosspost shares a post into other communities); a room page / community view
//     preselects its own
//   * "Pepe announces it in <room>" for the picked community, only when its owner switched announcements on
//     (1.99cu: always shown for the picked pad; default ON for Camfrog pads; greyed out with the reason - announcements
//     off, no Camfrog room, Pepe not in the room - when he can't; disabled boxes are never sent nor kept in the draft)
//   * (1.99di) "✨ Generate": a picture or video made by Pepe's !imagine / !video (aigen.js) - prompt, price, a
//     preview with progress, then Attach / Regenerate (charged again) / Discard (not refunded); jobs are kept on
//     the server, so leaving the page loses nothing; (1.99dn) an optional reference picture - an upload (the
//     normal upload pipeline, never added to the post) or a picture from this draft - priced + Pepe's -cam surcharge;
//     (1.99dr) or a CAM SNAPSHOT from the picked pad's Camfrog room: "📷 From a cam in this room" lists who's on cam
//     (aigen.js camList - incognito / hidden people never), asks Pepe for a fresh snapshot (the bridge's snap job)
//     and claims it (/api/feed/aigen/camref); the pad page's snapshot popover hands one over with "✨ Use in
//     Generate" (the `patv:gen-cam` event, or sessionStorage "patvGenCam" when the composer is on another page)
// Page: the pad bar, sort and pager links on /feed and /feed/following (data-swap)
// swap #fdTop / #fdList in place (fetch + DOMParser) with history entries, so nothing typed in the
// composer is ever lost.
(function () {
  'use strict';
  if (window.__patvComposer) return;
  window.__patvComposer = true;

  function api(url, body, method) {
    return fetch(url, {
      method: method || 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) {
        if (!r.ok || d.ok === false) { var e = new Error(d.error || ('HTTP ' + r.status)); e.code = d.code; throw e; }
        return d;
      });
    });
  }

  // ── /feed: swap the list in place ──
  var SWAP_IDS = ['fdTop', 'fdList'];
  var swapping = null;
  // the feed's own addresses: /feed (All), /feed/following (1.99ck: one pad's feed is its pad page /p/<slug>)
  function feedPath(p) { return p === '/feed' || p === '/feed/following'; }
  function canSwap() { return !!document.getElementById('fdList') && feedPath(location.pathname); }
  function swap(url, push) {
    if (!canSwap()) { location.href = url; return Promise.resolve(); }
    var u = new URL(url, location.href);
    if (u.origin !== location.origin || !feedPath(u.pathname)) { location.href = url; return Promise.resolve(); }
    var list = document.getElementById('fdList');
    list.setAttribute('aria-busy', 'true'); list.classList.add('fd-loading');
    var mine = swapping = fetch(u.toString(), { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch-page' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (html) {
        if (mine !== swapping) return;
        var doc = new DOMParser().parseFromString(html, 'text/html');
        SWAP_IDS.forEach(function (id) {
          var a = document.getElementById(id), b = doc.getElementById(id);
          if (a && b) a.innerHTML = b.innerHTML;
        });
        if (doc.title) document.title = doc.title;
        if (push) history.pushState({ patvSwap: 1 }, '', u.pathname + u.search);
        document.dispatchEvent(new CustomEvent('patv:feed-swapped'));
      })
      .catch(function () { location.href = u.toString(); })
      .then(function () { var l = document.getElementById('fdList'); if (l) { l.removeAttribute('aria-busy'); l.classList.remove('fd-loading'); } });
    return mine;
  }
  window.patvFeedSwap = swap;
  document.addEventListener('click', function (ev) {
    var a = ev.target.closest('a[data-swap]');
    if (!a || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    if (!canSwap()) return;
    ev.preventDefault();
    swap(a.getAttribute('href'), true);
  });
  window.addEventListener('popstate', function () { if (canSwap()) swap(location.href, false); });
  // 1.99ci: the community bar's search box (the bar is swapped in place, so delegated)
  document.addEventListener('input', function (ev) {
    var inp = ev.target;
    if (!inp.hasAttribute || !inp.hasAttribute('data-cb-search')) return;
    var menu = inp.closest('.cb-menu'), n = inp.value.trim().toLowerCase(), any = false;
    menu.querySelectorAll('.cb-it[data-name]').forEach(function (a) { var hit = !n || a.getAttribute('data-name').indexOf(n) >= 0; a.classList.toggle('hide', !hit); any = any || hit; });
    var none = menu.querySelector('[data-cb-none]'); if (none) none.classList.toggle('hide', any || !n);
  });
  document.addEventListener('toggle', function (ev) {
    var d = ev.target;
    if (!d.matches || !d.matches('details.cb-pick') || !d.open) return;
    var s = d.querySelector('[data-cb-search]');
    if (s && window.matchMedia('(pointer: fine)').matches) setTimeout(function () { s.focus(); }, 0);
  }, true);
  document.addEventListener('click', function (ev) {
    // close the community menu on an outside click / after picking
    document.querySelectorAll('details.cb-pick[open]').forEach(function (d) { if (!d.contains(ev.target) || ev.target.closest('.cb-it')) d.removeAttribute('open'); });
  });

  // ── the composer ──
  var form = document.getElementById('fcForm');
  if (!form) return;
  var CHUNK = parseInt(form.getAttribute('data-chunk'), 10) || 524288;
  var caps = {}, prices = {};
  try { caps = JSON.parse(form.getAttribute('data-caps')); prices = JSON.parse(form.getAttribute('data-prices')); } catch (e) { /* defaults */ }
  var maxImages = parseInt(form.getAttribute('data-max-images'), 10) || 4;
  var list = document.getElementById('fcFiles');
  var errEl = document.getElementById('fcErr');
  var go = document.getElementById('fcGo');
  var files = [];        // {kind, name, id, state, el, url}
  var linkRow = document.getElementById('fcLinkRow');
  var onFileRemoved = null;   // 1.99dn: the Generate panel drops a draft picture used as its reference
  var pv = document.getElementById('fcPv');
  var DRAFT_KEY = 'patvFeedDraft:' + (form.getAttribute('data-user') || '_');
  var DRAFT_TTL = 5 * 3600 * 1000;       // the server drops never-posted uploads after 6 h

  function setErr(t) { errEl.textContent = t || ''; errEl.classList.remove('ok'); }
  function cost() {
    var el = document.getElementById('fcCost');
    var paid = Object.keys(prices).some(function (k) { return prices[k] > 0; });
    if (!paid || !el) return;
    var n = { image: 0, audio: 0, video: 0 };
    files.forEach(function (f) { if (f.state !== 'failed') n[f.kind]++; });
    var c = (prices.post || 0) + (form.elements.link.value.trim() ? prices.link || 0 : 0) + n.image * (prices.image || 0) + n.audio * (prices.audio || 0) + n.video * (prices.video || 0);
    el.textContent = c ? 'This post costs ' + c.toLocaleString('en-US') + ' PAT.' : 'This post is free.';
  }
  function busy() { return files.some(function (f) { return f.state === 'uploading' || f.state === 'processing'; }); }
  function refreshGo() { go.disabled = busy(); go.textContent = busy() ? 'Uploading…' : 'Post'; cost(); saveSoon(); }

  // ── draft (localStorage, a convenience: any failure just means no draft) ──
  function picked() { var x = form.querySelector('input[name=community]:checked'); return x ? x.value : ''; }
  function roomsChecked() { var c = picked(); return c ? [c] : []; }
  function announceOff() { return Array.prototype.slice.call(form.querySelectorAll('input[name=announce]:not(:disabled)')).filter(function (x) { return !x.checked; }).map(function (x) { return x.value; }); }
  function draft() {
    return {
      v: 1, at: Date.now(), path: location.pathname,
      title: form.elements.title.value, body: form.elements.body.value, link: form.elements.link.value, nsfw: form.elements.nsfw.checked,
      community: picked(), announceOff: announceOff(),
      files: files.filter(function (f) { return (f.state === 'ready' || f.restoring) && f.id; }).map(function (f) { return { id: f.id, kind: f.kind, name: f.name, url: f.url || null, ai: !!f.ai }; })
    };
  }
  function empty(d) { return !d.title.trim() && !d.body.trim() && !d.link.trim() && !d.files.length; }
  var saveTimer = null, restoring = false;
  function saveNow() {
    if (restoring) return;
    try {
      var d = draft();
      if (empty(d)) localStorage.removeItem(DRAFT_KEY); else localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch (e) { /* private mode / storage full */ }
  }
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* none */ } }
  form.addEventListener('input', saveSoon);
  window.addEventListener('pagehide', saveNow);

  form.querySelector('[data-tool=link]').addEventListener('click', function () {
    linkRow.classList.toggle('hide');
    if (!linkRow.classList.contains('hide')) form.elements.link.focus();
  });
  var pvTimer = null, pvFor = '';
  function preview() {
    var u = form.elements.link.value.trim();
    cost();
    if (!u || u === pvFor) return;
    pvFor = u;
    pv.textContent = 'Checking the link…';
    api('/api/feed/preview', { url: u }).then(function (d) {
      if (form.elements.link.value.trim() !== u) return;
      var p = d.preview;
      pv.innerHTML = '';
      var a = document.createElement('div'); a.className = 'fp-link' + (p.image ? ' has-img' : '');
      if (p.image) { var im = document.createElement('img'); im.src = p.image; im.alt = ''; a.appendChild(im); }
      var t = document.createElement('span'); t.className = 't';
      var bb = document.createElement('b'); bb.textContent = p.title || p.domain; t.appendChild(bb);
      if (p.description) { var dd = document.createElement('span'); dd.className = 'd'; dd.textContent = p.description; t.appendChild(dd); }
      var dm = document.createElement('span'); dm.className = 'dom'; dm.textContent = '🔗 ' + p.domain + (p.embed ? ' · ' + p.embed + ' (plays in the post)' : ''); t.appendChild(dm);
      a.appendChild(t); pv.appendChild(a);
    }).catch(function (e) { if (form.elements.link.value.trim() === u) pv.textContent = '⚠️ ' + e.message; });
  }
  form.elements.link.addEventListener('input', function () { clearTimeout(pvTimer); pvTimer = setTimeout(preview, 700); });
  form.elements.link.addEventListener('blur', preview);

  function row(f, box) {
    var li = document.createElement('li');
    var th = document.createElement('span'); th.className = 'th'; th.textContent = f.kind === 'image' ? '🖼' : f.kind === 'audio' ? '🔊' : '🎬';
    var mid = document.createElement('div');
    var nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = f.name;
    var st = document.createElement('div'); st.className = 'st'; st.textContent = 'Starting…';
    var bar = document.createElement('div'); bar.className = 'bar'; var bi = document.createElement('i'); bar.appendChild(bi);
    mid.appendChild(nm); mid.appendChild(st); mid.appendChild(bar);
    var x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', 'Remove ' + f.name);
    x.addEventListener('click', function () {
      f.cancel = true;
      if (f.id) api('/api/feed/uploads/' + f.id + '/discard', {}).catch(function () {});
      files = files.filter(function (y) { return y !== f; }); li.remove(); refreshGo();
      if (onFileRemoved) onFileRemoved(f);
    });
    li.appendChild(th); li.appendChild(mid); li.appendChild(x);
    f.el = { li: li, th: th, st: st, bar: bar, bi: bi };
    (box || list).appendChild(li);
  }
  function say(f, t, bad) { f.el.st.textContent = t; f.el.st.classList.toggle('bad', !!bad); }
  function ready(f, att) {
    f.state = 'ready'; f.restoring = false;
    f.el.bi.style.width = '100%';
    say(f, (f.kind === 'image' ? 'Ready' : 'Ready · ' + (att.secs ? Math.round(att.secs) + 's' : '')) + ' ✔' + (f.ai ? ' · ✨ AI-generated' : ''));
    if (att.url && (f.kind === 'image' || f.kind === 'video')) {
      f.url = att.url;
      f.el.th.style.backgroundImage = 'url("' + att.url.replace(/["\\]/g, '') + '")'; f.el.th.textContent = '';
    }
    refreshGo();
  }

  function upload(f, file) {
    f.state = 'uploading'; refreshGo();
    return api('/api/feed/uploads', { kind: f.kind, size: file.size, name: file.name.slice(0, 100) }).then(function (d) {
      f.id = d.id;
      var chunk = d.chunk || CHUNK, off = 0;
      function next() {
        if (f.cancel) throw new Error('cancelled');
        if (off >= file.size) return api('/api/feed/uploads/' + f.id + '/finish', {});
        var part = file.slice(off, Math.min(file.size, off + chunk));
        return fetch('/api/feed/uploads/' + f.id + '?offset=' + off, {
          method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'fetch' }, body: part
        }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
          .then(function (j) {
            off = j.received;
            f.el.bi.style.width = Math.round(off / file.size * 100) + '%';
            say(f, 'Uploading ' + Math.round(off / file.size * 100) + '%');
            return next();
          });
      }
      return next();
    }).then(function () {
      f.state = 'processing'; say(f, f.kind === 'image' ? 'Processing…' : 'Converting (this can take a minute)…'); refreshGo();
      return new Promise(function (resolve, reject) {
        var tries = 0;
        (function poll() {
          if (f.cancel) return reject(new Error('cancelled'));
          fetch('/api/feed/uploads/' + f.id, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
            if (j.state === 'ready') return resolve(j.attachment);
            if (j.state === 'failed' || j.state === 'deleted' || !j.ok) return reject(new Error(j.error || 'That file couldn\'t be processed.'));
            if (++tries > 400) return reject(new Error('Processing took too long.'));
            setTimeout(poll, tries < 10 ? 800 : 2000);
          }).catch(function () { setTimeout(poll, 3000); });
        })();
      });
    }).then(function (att) { ready(f, att); }).catch(function (e) {
      if (f.cancel) return;
      f.state = 'failed'; say(f, '⚠️ ' + e.message, true); refreshGo();
    });
  }

  form.querySelectorAll('input[type=file][data-kind]').forEach(function (inp) {
    inp.addEventListener('change', function () {
      setErr('');
      var kind = inp.getAttribute('data-kind');
      Array.prototype.slice.call(inp.files || []).forEach(function (file) {
        var have = files.filter(function (x) { return x.kind === kind && x.state !== 'failed'; }).length;
        if (kind === 'image' && have >= maxImages) return setErr('At most ' + maxImages + ' pictures per post.');
        if (kind !== 'image' && have >= 1) return setErr('One ' + kind + ' file per post.');
        var capMb = caps[kind] || 10;
        if (file.size > capMb * 1024 * 1024) return setErr(file.name + ' is over ' + capMb + ' MB.');
        var f = { kind: kind, name: file.name, state: 'new' };
        files.push(f); row(f); upload(f, file);
      });
      inp.value = '';
    });
  });

  // ── ✨ Generate (1.99di, aigen.js): Pepe's !imagine / !video as this account, previewed here, then attached ──
  // Jobs live on the server: leaving the page keeps them (the list is fetched again on load, and an inbox notice
  // says when one is done). Charged when it's made, refunded if it fails or is refused; a discarded result isn't.
  var gen = document.getElementById('fcGen');
  if (gen) (function () {
    var cfg = {};
    try { cfg = JSON.parse(gen.getAttribute('data-aigen')) || {}; } catch (e) { cfg = {}; }
    var jobsEl = document.getElementById('fcGenJobs'), priceEl = document.getElementById('fcGenPrice'), goBtn = document.getElementById('fcGenGo');
    var gErr = document.getElementById('fcGenErr');
    var promptEl = form.elements.genPrompt;
    var cards = {};
    var PH = { image: 'Describe the picture… e.g. a frog DJ in a neon nightclub, synthwave style', video: 'Describe the clip… e.g. a frog surfing a huge wave at sunset, slow motion' };
    function kind() { var x = form.querySelector('input[name=genKind]:checked'); return x ? x.value : 'image'; }
    // 1.99dn: the reference picture (null | {id, url, name, state, upload: true for one uploaded just for this})
    // 1.99dr: or a cam snapshot {cam: true, id: claim id, url: data URL, name, room: pad id, state: 'ready'}
    var ref = null;
    var refCur = document.getElementById('fcGenRefCur'), refList = document.getElementById('fcGenRefList');
    var refDraftBtn = document.getElementById('fcGenRefDraft'), refFile = document.getElementById('fcGenRefFile');
    var refPriceEl = document.getElementById('fcGenRefPrice');
    function refPrice() { var p = (cfg.refPrices || {})[picked()]; if (p == null) p = cfg.refGlobal; return Number(p) || 0; }
    function baseOf(k) { var p = (cfg.prices || {})[picked()] || cfg.global || {}; return Number(p[k]) || 0; }
    function priceOf(k) { return baseOf(k) + (ref ? refPrice() : 0); }
    function fmtP(n) { return n ? Number(n).toLocaleString('en-US') + ' PAT' : 'free'; }
    function what(k) { return k === 'video' ? 'video' : 'picture'; }
    function setGErr(t) { gErr.textContent = t || ''; }
    function showPrice() {
      var k = kind();
      priceEl.textContent = (k === 'video' ? '🎬 A video' : '🖼 A picture') + ' costs ' + fmtP(priceOf(k)) + (ref ? ' (with the reference picture)' : '') + (picked() ? '' : ' (the price of the pad you pick)') + ' · ' + ((cfg.eta || {})[k] || '');
      promptEl.placeholder = ref ? (k === 'video' ? 'Describe how to animate the picture… e.g. they wave and smile, slow zoom' : 'Describe what to make from the picture… e.g. as a pirate captain, oil painting') : PH[k];
      if (refPriceEl) refPriceEl.textContent = fmtP(refPrice()) === 'free' ? 'nothing' : fmtP(refPrice());
    }
    function idem() { return 'g' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); }
    function el(tag, cls, text) { var x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; }
    function btn(text, cls, fn) { var b = el('button', cls || 'fc-gj-btn', text); b.type = 'button'; b.addEventListener('click', fn); return b; }
    function attached(id) { return files.some(function (f) { return f.id === id; }); }

    form.querySelector('[data-tool=gen]').addEventListener('click', function () {
      gen.classList.toggle('hide');
      if (!gen.classList.contains('hide')) { showPrice(); promptEl.focus(); }
    });
    form.addEventListener('change', function (ev) { if (ev.target.name === 'genKind' || ev.target.name === 'community') showPrice(); });
    promptEl.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); goBtn.click(); } });

    function start(k, prompt, again) {
      setGErr('');
      prompt = String(prompt || '').trim();
      if (prompt.length < 3) { setGErr('Describe what to make.'); promptEl.focus(); return; }
      if (ref && ref.state === 'failed') { setGErr('The reference picture failed - remove it or pick another.'); return; }
      if (ref && ref.state !== 'ready') { setGErr('Wait for the reference picture to finish uploading.'); return; }
      var price = priceOf(k);
      if (again && !window.confirm('Make a new ' + what(k) + ' from the same prompt? It costs ' + fmtP(price) + ' again - the one you have now is not refunded.')) return;
      goBtn.disabled = true;
      if (ref && ref.cam && ref.room !== picked()) { setGErr('That cam snapshot is from another pad\'s room - pick a cam here.'); return; }
      api('/api/feed/aigen', { kind: k, prompt: prompt, pad: picked() || null, price: price, ref: ref && !ref.cam ? ref.id : null,
                               camref: ref && ref.cam ? ref.id : null, back: location.pathname + location.search, idem: idem() })
        .then(function (d) { if (!again) promptEl.value = ''; card(d.job); poll(d.job.id); })
        .catch(function (e) { setGErr(e.message); })
        .then(function () { goBtn.disabled = false; });
    }
    goBtn.addEventListener('click', function () { start(kind(), promptEl.value, false); });

    // ── 1.99dn: the reference picture ──
    function clearRef(keepUpload) {
      if (ref && ref.upload && !keepUpload) { ref.cancel = true; if (ref.id) api('/api/feed/uploads/' + ref.id + '/discard', {}).catch(function () {}); }
      ref = null; refCur.innerHTML = ''; showPrice();
    }
    function refRow(r) {
      // a picture from the draft: its own little row (its ✕ only un-picks it - the draft keeps the picture)
      refCur.innerHTML = '';
      var li = el('li'), th = el('span', 'th'), mid = el('div'), x = el('button', null, '✕');
      if (r.url) { th.style.backgroundImage = 'url("' + String(r.url).replace(/["\\]/g, '') + '")'; } else th.textContent = '🖼';
      mid.appendChild(el('div', 'nm', r.name || 'Picture'));
      mid.appendChild(el('div', 'st', r.cam ? '📷 Cam snapshot ✔ · used only for this generation' : 'Reference picture ✔'));
      x.type = 'button'; x.setAttribute('aria-label', 'Don\'t use this picture as the reference');
      x.addEventListener('click', function () { clearRef(); });
      li.appendChild(th); li.appendChild(mid); li.appendChild(x); refCur.appendChild(li);
    }
    function pickDraft(f) {
      clearRef();
      ref = { id: f.id, url: f.url, name: f.name, state: 'ready', upload: false };
      refRow(ref); refList.classList.add('hide'); refDraftBtn.setAttribute('aria-expanded', 'false'); showPrice();
    }
    refDraftBtn.addEventListener('click', function () {
      setGErr('');
      var pics = files.filter(function (f) { return f.kind === 'image' && f.state === 'ready' && f.id; });
      refList.innerHTML = '';
      if (!pics.length) { refList.appendChild(el('p', 'mut', 'No pictures in this draft yet - add one with 🖼 Picture, or upload one here.')); }
      pics.forEach(function (f) {
        var b = el('button', 'fc-gen-ref-it'); b.type = 'button'; b.title = f.name; b.setAttribute('aria-label', 'Use ' + f.name + ' as the reference');
        if (f.url) b.style.backgroundImage = 'url("' + String(f.url).replace(/["\\]/g, '') + '")'; else b.textContent = '🖼';
        b.addEventListener('click', function () { pickDraft(f); });
        refList.appendChild(b);
      });
      var open = refList.classList.toggle('hide') === false;
      refDraftBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    refFile.addEventListener('change', function () {
      setGErr('');
      var file = (refFile.files || [])[0];
      refFile.value = '';
      if (!file) return;
      var capMb = caps.image || 10;
      if (file.size > capMb * 1024 * 1024) { setGErr(file.name + ' is over ' + capMb + ' MB.'); return; }
      clearRef();
      var f = { kind: 'image', name: file.name, state: 'new', upload: true };
      ref = f; refCur.innerHTML = '';
      row(f, refCur);
      showPrice();
      upload(f, file).then(function () { if (ref === f) showPrice(); });
    });
    // the ✕ on a draft picture (or on the uploaded reference's own row) drops it as the reference too
    onFileRemoved = function (f) { if (ref && (ref === f || (ref.id && ref.id === f.id))) { ref = null; refCur.innerHTML = ''; showPrice(); } };

    // ── 1.99dr: a cam in the picked pad's Camfrog room ──
    var camBtn = document.getElementById('fcGenRefCam'), camsEl = document.getElementById('fcGenRefCams');
    var camTimer = null, camSeq = 0;
    function camPad() { return (cfg.camPads || []).indexOf(picked()) >= 0; }
    function syncCamBtn() {
      if (!camBtn) return;
      camBtn.classList.toggle('hide', !camPad());
      if (!camPad()) { camsEl.classList.add('hide'); camBtn.setAttribute('aria-expanded', 'false'); }
      // a cam snapshot belongs to its pad's room: switching pads drops it
      if (ref && ref.cam && ref.room !== picked()) { clearRef(); setGErr('The cam snapshot was from another pad - pick a cam in this one.'); }
    }
    function useCam(c) {
      clearRef();
      ref = { cam: true, id: c.id, url: c.img, name: (c.display || 'Someone') + '\'s cam', room: c.room, state: 'ready' };
      refRow(ref); showPrice();
      if (camsEl) { camsEl.classList.add('hide'); camsEl.innerHTML = ''; }
      if (camBtn) camBtn.setAttribute('aria-expanded', 'false');
    }
    function camSay(text) { camsEl.innerHTML = ''; camsEl.appendChild(el('p', 'mut', text)); }
    function camSnap(slug, who, seq) {
      // Pepe takes a fresh snapshot through the bridge (the room's cam switch, rate limits and rules apply)
      clearTimeout(camTimer);
      camSay('Asking Pepe for a snapshot of ' + who.display + '\'s cam…');
      fetch('/api/rooms/' + encodeURIComponent(slug) + '/snap', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: who.login }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (seq !== camSeq) return; if (!d.ok) return camSay(d.error || 'Not right now.'); camPoll(slug, who, seq, 0); })
        .catch(function () { if (seq === camSeq) camSay('Couldn\'t reach the site.'); });
    }
    function camPoll(slug, who, seq, n) {
      camTimer = setTimeout(function () {
        fetch('/api/rooms/' + encodeURIComponent(slug) + '/snap/' + encodeURIComponent(who.login), { credentials: 'same-origin', cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (snap) {
            if (seq !== camSeq) return;
            if (snap.state === 'refused') return camSay((snap.status || 'Pepe couldn\'t get a picture') + '.');
            if (snap.state !== 'ok') { if (n > 30) return camSay('Pepe didn\'t get a picture in time - try again in a bit.'); return camPoll(slug, who, seq, n + 1); }
            if (!snap.gen || !snap.img) return camSay('That snapshot can\'t be used.');
            return api('/api/feed/aigen/camref', { pad: picked(), sid: snap.gen.sid }).then(function (c) {
              if (seq !== camSeq) return;
              useCam({ id: c.id, display: c.display, room: c.room, img: snap.img });
            });
          }).catch(function (e) { if (seq === camSeq) camSay(e && e.message ? e.message : 'Couldn\'t reach the site.'); });
      }, n ? 1500 : 800);
    }
    if (camBtn) camBtn.addEventListener('click', function () {
      setGErr('');
      var open = camsEl.classList.toggle('hide') === false;
      camBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) { camSeq++; clearTimeout(camTimer); return; }
      var seq = ++camSeq;
      camSay('Checking who\'s on cam…');
      fetch('/api/feed/aigen/cams?pad=' + encodeURIComponent(picked() || ''), { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (seq !== camSeq) return;
          if (!d || !d.ok) return camSay((d && d.error) || 'Not right now.');
          if (!d.cams || !d.cams.length) return camSay(d.why || 'Nobody is on cam there right now.');
          camsEl.innerHTML = '';
          d.cams.forEach(function (who) {
            var b = el('button', 'fc-gj-btn fc-gen-cam-it', '📷 ' + who.display); b.type = 'button';
            b.title = 'Ask Pepe for a fresh snapshot of ' + who.display + '\'s cam';
            b.addEventListener('click', function () { camSnap(d.slug, who, ++camSeq); });
            camsEl.appendChild(b);
          });
        }).catch(function () { if (seq === camSeq) camSay('Couldn\'t reach the site.'); });
    });
    form.addEventListener('change', function (ev) { if (ev.target.name === 'community') syncCamBtn(); });
    // "✨ Use in Generate" from the pad page's snapshot popover (same page), or handed over from another page
    function takeCam(c) {
      if (!c || !c.id || !c.img) return;
      var radio = form.querySelector('input[name=community][value="' + String(c.room || '').replace(/["\\]/g, '') + '"]');
      if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
      if (picked() !== c.room) { gen.classList.remove('hide'); setGErr('You can\'t post in that pad, so its cam can\'t be used here.'); return; }
      gen.classList.remove('hide');
      useCam(c);
      setGErr('');
      try { gen.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* old browsers */ }
      promptEl.focus();
    }
    document.addEventListener('patv:gen-cam', function (ev) { takeCam(ev.detail); });
    try {
      var handed = JSON.parse(sessionStorage.getItem('patvGenCam') || 'null');
      sessionStorage.removeItem('patvGenCam');
      if (handed && handed.until > Date.now()) setTimeout(function () { takeCam(handed); }, 0);
    } catch (e) { /* no storage: nothing handed over */ }
    syncCamBtn();

    function statusLine(j) {
      if (j.status === 'queued') return 'Waiting for Pepe…';
      if (j.status === 'running') return 'Generating… ' + (j.eta || '') + ' · ' + (j.elapsed || 0) + ' s - you can leave this page: it is kept, and you get a notice when it is done.';
      if (j.status === 'done') return 'Ready · ' + (j.cost ? fmtP(j.cost) + ' charged' : 'free') + (j.nsfw ? ' · 🔞 Pepe marked it NSFW - a post with it is NSFW' : '');
      return '⚠️ ' + (j.message || 'It failed') + (j.refunded ? ' · refunded' : (j.cost ? '' : ' · nothing charged'));
    }
    function card(j) {
      if (j.attachment && attached(j.attachment.id)) return;
      var c = cards[j.id];
      if (!c) { c = cards[j.id] = { el: el('div', 'fc-gj') }; jobsEl.insertBefore(c.el, jobsEl.firstChild); }
      c.job = j;
      var box = c.el;
      box.innerHTML = '';
      box.setAttribute('data-status', j.status);
      var m = el('div', 'fc-gj-m');
      if (j.status === 'done' && j.attachment) {
        if (j.kind === 'video') {
          var v = document.createElement('video'); v.src = j.attachment.file; if (j.attachment.poster) v.poster = j.attachment.poster;
          v.controls = true; v.playsInline = true; v.preload = 'metadata'; m.appendChild(v);
        } else {
          var im = document.createElement('img'); im.src = j.attachment.url; im.alt = 'Generated picture: ' + j.prompt; m.appendChild(im);
        }
        m.appendChild(el('span', 'fp-ai-badge', '✨ AI'));
      } else if (j.status === 'queued' || j.status === 'running') {
        m.appendChild(el('span', 'fc-gj-spin')); m.setAttribute('aria-busy', 'true');
      } else {
        m.appendChild(el('span', 'fc-gj-x', '⚠️'));
      }
      var b = el('div', 'fc-gj-b');
      var q = el('div', 'fc-gj-q'); q.appendChild(el('b', null, j.kind === 'video' ? '🎬 ' : '🖼 ')); q.appendChild(document.createTextNode(j.prompt)); b.appendChild(q);
      b.appendChild(el('div', 'fc-gj-st' + (j.status === 'failed' || j.status === 'timeout' ? ' bad' : ''), statusLine(j)));
      var acts = el('div', 'fc-gj-acts');
      if (j.status === 'done' && j.attachment) {
        acts.appendChild(btn('📎 Attach to post', 'fc-gj-btn pri', function () { attach(j); }));
        acts.appendChild(btn('↻ Regenerate · ' + fmtP(priceOf(j.kind)), null, function () { start(j.kind, j.prompt, true); }));
        acts.appendChild(btn('Discard', 'fc-gj-btn ghost', function () {
          if (!window.confirm('Discard this ' + what(j.kind) + '? ' + (j.cost && !j.refunded ? 'The ' + fmtP(j.cost) + ' is not refunded - it was made.' : ''))) return;
          api('/api/feed/aigen/' + j.id + '/discard', {}).then(function () { drop(j.id); }).catch(function (e) { setGErr(e.message); });
        }));
        var lab = el('label', 'fc-gj-show ck'); var ck = document.createElement('input'); ck.type = 'checkbox'; ck.checked = !j.attachment.hidePrompt;
        ck.addEventListener('change', function () {
          api('/api/feed/attachments/' + j.attachment.id + '/ai-prompt', { show: ck.checked }).then(function () { j.attachment.hidePrompt = !ck.checked; })
            .catch(function (e) { ck.checked = !ck.checked; setGErr(e.message); });
        });
        lab.appendChild(ck); lab.appendChild(document.createTextNode(' Show the prompt on the post')); acts.appendChild(lab);
      } else if (j.status === 'queued') {
        acts.appendChild(btn('Cancel', 'fc-gj-btn ghost', function () {
          api('/api/feed/aigen/' + j.id + '/discard', {}).then(function () { drop(j.id); }).catch(function (e) { setGErr(e.message); });
        }));
      } else if (j.status === 'failed' || j.status === 'timeout') {
        acts.appendChild(btn('Try again', null, function () { drop(j.id); start(j.kind, j.prompt, false); }));
        acts.appendChild(btn('Dismiss', 'fc-gj-btn ghost', function () { drop(j.id); }));
      }
      b.appendChild(acts);
      box.appendChild(m); box.appendChild(b);
      gen.classList.remove('hide');
    }
    function drop(id) { var c = cards[id]; if (c) { clearTimeout(c.timer); c.el.remove(); delete cards[id]; } }
    function poll(id) {
      var c = cards[id];
      if (!c) return;
      clearTimeout(c.timer);
      var j = c.job;
      if (j.status !== 'queued' && j.status !== 'running') return;
      c.timer = setTimeout(function () {
        fetch('/api/feed/aigen/' + id, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
          if (!cards[id]) return;
          if (d && d.ok && d.job) { card(d.job); poll(id); } else if (d && d.error) { drop(id); }
        }).catch(function () { poll(id); });
      }, j.kind === 'video' ? 4000 : 2500);
    }
    function attach(j) {
      setErr('');
      var k = j.kind, have = files.filter(function (x) { return x.kind === k && x.state !== 'failed'; }).length;
      if (k === 'image' && have >= maxImages) return setGErr('At most ' + maxImages + ' pictures per post.');
      if (k === 'video' && have >= 1) return setGErr('One video per post.');
      var f = { kind: k, name: '✨ ' + j.prompt.slice(0, 80), id: j.attachment.id, state: 'processing', ai: true };
      files.push(f); row(f); ready(f, { url: j.attachment.url, secs: j.attachment.secs });
      drop(j.id);
    }
    // jobs already going or finished (another page, a reload) - not the ones the restored draft holds
    fetch('/api/feed/aigen?pad=' + encodeURIComponent(picked() || ''), { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) return;
      (d.jobs || []).slice().reverse().forEach(function (j) { card(j); poll(j.id); });
    }).catch(function () { /* the panel still works */ });
    showPrice();
  })();

  // ── the community picker (1.99ci): one community, searchable; the announce checkbox follows it ──
  var comm = form.querySelector('.fc-comm');
  function syncAnnounce() {
    var on = roomsChecked();
    form.querySelectorAll('[data-ann-for]').forEach(function (l) { l.classList.toggle('hide', on.indexOf(l.getAttribute('data-ann-for')) < 0); });
    // 1.99dc: "Posting in p/x: read the rules" follows the picked pad too
    form.querySelectorAll('[data-rules-for]').forEach(function (l) { l.classList.toggle('hide', on.indexOf(l.getAttribute('data-rules-for')) < 0); });
  }
  function showPicked() {
    if (!comm) return;
    var x = form.querySelector('input[name=community]:checked');
    var cur = comm.querySelector('[data-comm-cur]');
    cur.textContent = '';
    var b = document.createElement('span'); b.className = 'cbadge sm' + (x ? '' : ' all'); b.setAttribute('aria-hidden', 'true');
    var t = document.createElement('b');
    if (x) {
      b.textContent = x.getAttribute('data-badge') || '';
      b.style.setProperty('--h', x.getAttribute('data-hue') || '0');
      t.textContent = x.getAttribute('data-title') || x.value;
      // 1.99df: the label is p/<slug>, or u/<username> for "Your profile"
      var sm = document.createElement('small'); sm.textContent = x.getAttribute('data-label') || ('p/' + (x.getAttribute('data-slug') || ''));
      cur.appendChild(b); cur.appendChild(t); cur.appendChild(sm);
      comm.removeAttribute('data-empty');
    } else {
      b.textContent = '?'; t.textContent = 'Choose a pad';
      cur.appendChild(b); cur.appendChild(t);
      comm.setAttribute('data-empty', '');
    }
  }
  var cs = comm ? comm.querySelector('[data-comm-search]') : null;
  if (cs) {
    cs.addEventListener('input', function () {
      var n = cs.value.trim().toLowerCase(), any = false;
      comm.querySelectorAll('.fc-comm-it').forEach(function (l) { var hit = !n || (l.getAttribute('data-name') || '').indexOf(n) >= 0; l.classList.toggle('hide', !hit); any = any || hit; });
      var none = comm.querySelector('[data-comm-none]'); if (none) none.classList.toggle('hide', any);
    });
    comm.addEventListener('toggle', function () { if (comm.open && window.matchMedia('(pointer: fine)').matches) setTimeout(function () { cs.focus(); }, 0); });
    document.addEventListener('click', function (ev) { if (comm.open && !comm.contains(ev.target)) comm.open = false; });
    // Enter in the search box picks the first match instead of submitting the post
    cs.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var first = Array.prototype.slice.call(comm.querySelectorAll('.fc-comm-it')).filter(function (l) { return !l.classList.contains('hide'); })[0];
      if (first) { var r = first.querySelector('input'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
    });
  }
  form.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t.name === 'community') { syncAnnounce(); showPicked(); if (comm) comm.open = false; setErr(''); }
    saveSoon();
  });

  // ── restore a saved draft ──
  (function restore() {
    var d = null;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { d = null; }
    if (!d || d.v !== 1 || !(Date.now() - d.at < DRAFT_TTL)) { if (d) clearDraft(); return; }
    restoring = true;
    if (d.title) form.elements.title.value = String(d.title).slice(0, 140);
    if (d.body) form.elements.body.value = String(d.body).slice(0, 5000);
    if (d.link) { form.elements.link.value = String(d.link).slice(0, 2000); linkRow.classList.remove('hide'); }
    form.elements.nsfw.checked = !!d.nsfw;
    // the community: kept unless this page has its own (a room page / community view preselects it)
    if (d.community && !form.getAttribute('data-home')) {
      form.querySelectorAll('input[name=community]').forEach(function (x) { x.checked = x.value === d.community; });
    }
    showPicked();
    if (Array.isArray(d.announceOff)) form.querySelectorAll('input[name=announce]:not(:disabled)').forEach(function (x) { x.checked = d.announceOff.indexOf(x.value) < 0; });
    syncAnnounce();
    var pending = (Array.isArray(d.files) ? d.files : []).slice(0, 6).filter(function (x) { return x && /^[a-f0-9]{24}$/.test(String(x.id)); });
    pending.forEach(function (x) {
      var f = { kind: x.kind === 'audio' || x.kind === 'video' ? x.kind : 'image', name: String(x.name || 'file').slice(0, 100), id: x.id, state: 'processing', restoring: true, url: x.url || null, ai: !!x.ai };
      files.push(f); row(f); say(f, 'Checking…');
      fetch('/api/feed/uploads/' + f.id, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.ok && j.state === 'ready' && j.attachment) ready(f, j.attachment);
        else { files = files.filter(function (y) { return y !== f; }); f.el.li.remove(); refreshGo(); }
      }).catch(function () { files = files.filter(function (y) { return y !== f; }); f.el.li.remove(); refreshGo(); });
    });
    restoring = false;
    if (d.link) preview();
    errEl.textContent = 'Draft restored'; errEl.classList.add('ok');
    var clr = document.createElement('button'); clr.type = 'button'; clr.className = 'fc-clear'; clr.textContent = 'Discard draft';
    clr.addEventListener('click', function () {
      files.forEach(function (f) { f.cancel = true; if (f.id) api('/api/feed/uploads/' + f.id + '/discard', {}).catch(function () {}); if (f.el) f.el.li.remove(); });
      files = [];
      form.elements.title.value = ''; form.elements.body.value = ''; form.elements.link.value = ''; form.elements.nsfw.checked = false; pv.textContent = '';
      clearDraft(); setErr(''); clr.remove(); refreshGo();
    });
    errEl.parentNode.insertBefore(clr, errEl.nextSibling);
  })();

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    setErr('');
    if (busy()) return setErr('Wait for the uploads to finish.');
    var roomsSel = roomsChecked();
    if (!roomsSel.length) { setErr('Choose a pad to post in.'); if (comm) comm.open = true; return; }
    var announce = Array.prototype.slice.call(form.querySelectorAll('input[name=announce]:checked:not(:disabled)'))
      .map(function (x) { return x.value; }).filter(function (v) { return roomsSel.indexOf(v) >= 0; });
    var body = {
      title: form.elements.title.value, body: form.elements.body.value, link: form.elements.link.value.trim(), nsfw: form.elements.nsfw.checked,
      community: roomsSel[0], announce: announce,
      // 1.99df: a profile post's "Also show in All" (the box only exists for the profile choice)
      inAll: form.elements.inAll ? form.elements.inAll.checked : undefined,
      attachments: files.filter(function (f) { return f.state === 'ready'; }).map(function (f) { return f.id; })
    };
    // 1.99cc: the Terms tick box (shown until this account accepted the current version)
    var tk = form.elements.acceptTerms;
    if (tk && !tk.checked) { setErr('Tick the box to accept the Terms of Service first.'); tk.focus(); return; }
    if (tk && tk.checked) body.acceptTerms = true;
    go.disabled = true; go.textContent = 'Posting…';
    api('/api/feed/posts', body).catch(function (e) {
      // not accepted yet (a page from before the change): ask once, then post again
      if (e.code !== 'terms' || !window.patvSafety) throw e;
      return window.patvSafety.termsAsk().then(function (yes) {
        if (!yes) throw new Error('You need to accept the Terms of Service to post.');
        body.acceptTerms = true;
        return api('/api/feed/posts', body);
      });
    }).then(function (d) {
      clearTimeout(saveTimer); clearDraft(); restoring = true;     // posted: the draft is done
      errEl.textContent = 'Posted ✔'; errEl.classList.add('ok');
      // stay on a pad page (the new post shows on top of New); elsewhere open the post
      var u = new URL(location.href);
      // 1.99df: on a profile (the profile feed) - back to its posts (1.99dv: the Posts tab, /u/<username>/posts)
      if (/^\/u\/[^/]+(\/posts)?\/?$/.test(u.pathname)) { ['psort', 'pp', 'pt'].forEach(function (k) { u.searchParams.delete(k); }); u.hash = '';
        u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/posts$/, '') + '/posts';
        var tp = u.toString();
        if (tp === location.href.split('#')[0]) location.reload(); else location.href = tp; }
      else if (/^\/p\/[^/]+\/?$/.test(u.pathname)) { ['fsort', 'fp', 'sort', 'p', 't', 'ft'].forEach(function (k) { u.searchParams.delete(k); }); u.hash = 'feed';
        var target = u.toString();
        if (target.split('#')[0] === location.href.split('#')[0]) { location.hash = 'feed'; location.reload(); } else location.href = target; }
      else location.href = d.url;
    }).catch(function (e) { setErr(e.message); go.disabled = false; go.textContent = 'Post'; });
  });
  refreshGo();
})();
