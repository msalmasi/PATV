/* raffles.js - 1.99xk: 🎫 PAT Raffles pages (/raffles, /raffles/<id>; raffles.js on the server).
   - forms [data-rf-form] post JSON to their data-rf-url (X-Requested-With: fetch, same site): checkboxes as true / false,
     "config.x" names nested, datetime-local values sent with the viewer's time-zone offset (tz, minutes); the answer shows in
     #rf-msg, then data-rf-done = "reload" | "go" (the new raffle's page)
   - the create form shows the fields of the picked prize / trigger only
   - countdowns [data-rf-at] tick once a second; the buy form's total follows the quantity
   - the fairness box re-checks the revealed seed in the browser (sha256 commitment, the tickets digest, the winning number from
     the HMAC-SHA256 word stream - casino/fair.js rules)
   Pure helpers (left, ticketLine) are exported for node tests. */
(function () {
  'use strict';
  function leftParts(ms) {
    var s = Math.floor(ms / 1000);
    if (!(s > 0)) return null;
    if (s >= 86400) return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
    if (s >= 3600) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }
  function ticketLine(t) { return t[0] + '-' + t[1] + ':' + String(t[2] || '').toLowerCase() + '\n'; }
  var api = { left: leftParts, ticketLine: ticketLine };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  if (typeof document === 'undefined') return;

  var _t = function (k, d, v) { return window.__t ? window.__t(k, d, v) : String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var NUM = (function () { try { return new Intl.NumberFormat((window.PATV_I18N && window.PATV_I18N.lang) || undefined); } catch (e) { return null; } })();
  var num = function (n) { n = Math.floor(Number(n) || 0); return NUM ? NUM.format(n) : String(n); };

  function say(text, ok) {
    var m = document.getElementById('rf-msg');
    if (!m) { if (!ok) alert(text); return; }
    m.textContent = text;
    m.className = 'rf-msg ' + (ok ? 'ok' : 'bad');
    m.hidden = false;
    try { m.scrollIntoView({ block: 'nearest' }); } catch (e) { /* old browsers */ }
  }
  function body(form) {
    var out = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.disabled) return;
      if (el.closest && el.closest('[hidden]')) return;
      var v;
      if (el.type === 'checkbox') v = !!el.checked;
      else if (el.type === 'radio') { if (!el.checked) return; v = el.value; }
      else if (el.type === 'submit' || el.type === 'button') return;
      else v = el.value;
      var parts = el.name.split('.');
      var o = out;
      for (var i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] || {}; o = o[parts[i]]; }
      o[parts[parts.length - 1]] = v;
    });
    if ('tz' in out) out.tz = new Date().getTimezoneOffset();
    return out;
  }
  function submit(form, e) {
    e.preventDefault();
    var ask = form.getAttribute('data-rf-confirm');
    if (ask && !confirm(ask)) return;
    var btn = form.querySelector('button[type=submit]');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    fetch(form.getAttribute('data-rf-url'), {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Accept: 'application/json' },
      body: JSON.stringify(body(form)),
    }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); }).then(function (j) {
      if (!j || !j.ok) {
        say((j && j.error) || _t('js.rf.failed', "That didn't work - nothing was charged. Try again."), false);
        if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
        return;
      }
      var done = form.getAttribute('data-rf-done');
      if (done === 'go' && j.id) { location.href = '/raffles/' + j.id; return; }
      say(_t('js.rf.done', 'Done.'), true);
      setTimeout(function () { location.reload(); }, 600);
    }).catch(function () {
      say(_t('js.rf.offline', "The site didn't answer - nothing was charged. Try again."), false);
      if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
    });
  }

  function toggles(form) {
    var kind = form.querySelector('input[name=prize_kind]:checked');
    var trig = form.querySelector('input[name=trigger]:checked');
    Array.prototype.forEach.call(form.querySelectorAll('[data-rf-show]'), function (el) { el.hidden = !kind || el.getAttribute('data-rf-show') !== kind.value; });
    Array.prototype.forEach.call(form.querySelectorAll('[data-rf-show-trig]'), function (el) { el.hidden = !trig || el.getAttribute('data-rf-show-trig') !== trig.value; });
  }

  function tick() {
    var now = Date.now();
    Array.prototype.forEach.call(document.querySelectorAll('[data-rf-at]'), function (el) {
      var l = leftParts(Number(el.getAttribute('data-rf-at')) - now);
      var draw = el.getAttribute('data-rf-kind') === 'draw';
      el.textContent = !l ? _t('js.rf.now', 'any moment now') : draw ? _t('js.rf.draws_in', 'draws in {left}', { left: l }) : _t('js.rf.expires_in', 'expires in {left}', { left: l });
    });
  }

  function total(form) {
    var price = Number(form.getAttribute('data-rf-price')) || 0;
    var q = Math.max(0, Math.floor(Number(form.qty.value) || 0));
    var out = form.querySelector('[data-rf-total]');
    if (out) out.textContent = _t('js.rf.total', 'Total: {pat} PAT', { pat: num(price * q) });
  }

  // ── fairness: the browser re-derives the winning ticket ──
  var enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function winning(seed, digest, id, n) {
    return crypto.subtle.importKey('raw', enc.encode(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']).then(function (key) {
      var counter = 0, words = [], pos = 8;
      function next() {
        if (pos < 8) return Promise.resolve(words[pos++]);
        return crypto.subtle.sign('HMAC', key, enc.encode(digest + ':R' + id + ':' + counter++)).then(function (sig) {
          var dv = new DataView(sig); words = []; for (var k = 0; k < 8; k++) words.push(dv.getUint32(4 * k, false));
          pos = 0; return words[pos++];
        });
      }
      var limit = Math.floor(4294967296 / n) * n;
      function draw() { return next().then(function (x) { return x < limit ? 1 + (x % n) : draw(); }); }
      return draw();
    });
  }
  function verify(box, id) {
    var out = box.querySelector('[data-rf-verify]');
    if (!out || !enc || !window.crypto || !crypto.subtle) return;
    fetch('/api/raffles/' + id + '/fair', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (rec) {
      if (!rec || !rec.ok || !rec.server_seed) { out.textContent = _t('js.rf.fair_none', 'Nothing to check yet.'); return; }
      var lines = (rec.tickets || []).map(ticketLine).join('');
      return Promise.all([crypto.subtle.digest('SHA-256', enc.encode(rec.server_seed)), crypto.subtle.digest('SHA-256', enc.encode(lines)),
                          winning(rec.server_seed, rec.tickets_digest, rec.id, rec.sold)]).then(function (r) {
        var marks = [[hex(r[0]) === rec.commitment, _t('js.rf.fair_c', 'the seed matches the commitment published when the raffle opened')],
                     [hex(r[1]) === rec.tickets_digest, _t('js.rf.fair_d', 'the ticket list matches the digest')],
                     [r[2] === rec.winning_no, _t('js.rf.fair_n', 'ticket #{no} follows from them', { no: num(r[2]) })]];
        while (out.firstChild) out.removeChild(out.firstChild);
        marks.forEach(function (m, i) {
          if (i) out.appendChild(document.createTextNode(' · '));
          var s = document.createElement('span'); s.className = m[0] ? 'ok' : 'bad'; s.textContent = (m[0] ? '✓ ' : '✗ ') + m[1]; out.appendChild(s);
        });
      });
    }).catch(function () { out.textContent = _t('js.rf.fair_err', "Couldn't load the record."); });
  }

  function boot() {
    Array.prototype.forEach.call(document.querySelectorAll('form[data-rf-form]'), function (f) {
      f.addEventListener('submit', function (e) { submit(f, e); });
      if (f.getAttribute('data-rf-form') === 'create') {
        f.addEventListener('change', function () { toggles(f); });
        toggles(f);
      }
      if (f.getAttribute('data-rf-form') === 'buy') {
        f.addEventListener('input', function () { total(f); });
        Array.prototype.forEach.call(f.querySelectorAll('[data-rf-qty]'), function (b) {
          b.addEventListener('click', function () { f.qty.value = b.getAttribute('data-rf-qty'); total(f); });
        });
        total(f);
      }
    });
    tick();
    setInterval(function () { if (document.visibilityState !== 'hidden') tick(); }, 1000);
    var one = document.getElementById('rf-one'), proof = document.getElementById('rf-proof');
    if (one && proof) verify(proof, one.getAttribute('data-rf-id'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
