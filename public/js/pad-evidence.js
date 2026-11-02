// pad-evidence.js - wave 2 WP-5 (incognito / mic-stage spec E.3): moderation evidence clips (evidence.js). Plain ES5, no dependencies.
//
//   * the pad page: a revealed veiled 🎙 line whose reveal answer said ev: 1 (an admin, or the pad's owner in their era, inside Pepe's
//     15 minutes, evidence clips switched on) gets "Save as evidence" (room.ejs applyReveal -> PATVPadEvidence.open). The card asks Pepe
//     for the turn's audio (POST /api/rooms/:slug/evidence - logged on the server before Pepe is asked), plays the preview (no trim),
//     takes an optional reason, and saves it (POST .../save - logged again) or discards it. Never posted anywhere.
//   * pad settings, chat tab (#evidence, the pad's OWNER only): the pad's evidence clips - metadata, played inline (every play logged).
// Everything user-visible goes in via textContent; requests are same-origin fetches (X-Requested-With: fetch), never cached.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    if (d && typeof d === 'object') d = v && v.count === 1 ? d.one : d.other;
    return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function req(method, url, body) {
    var o = { method: method, credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { 'x-requested-with': 'fetch' } };
    if (body) { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(url, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok || d.ok === false) { var x = new Error(d.error || ('HTTP ' + r.status)); x.status = r.status; x.code = d.code; throw x; }
        return d;
      });
    });
  }
  function day(ms) { try { return new Date(Number(ms)).toLocaleDateString(document.documentElement.lang || undefined, { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return new Date(Number(ms)).toISOString().slice(0, 10); } }
  function when(ms) { try { return new Date(Number(ms)).toLocaleString(document.documentElement.lang || undefined); } catch (e) { return new Date(Number(ms)).toISOString(); } }

  /** The save card for line c of pad `slug`, put after `anchor`. done() runs when it closes. */
  function open(slug, c, anchor, done) {
    var base = '/api/rooms/' + encodeURIComponent(slug) + '/evidence';
    var card = el('div', 'ev-card');
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', _t('js.pad.ev.title', 'Moderation evidence'));
    card.style.cssText = 'margin:6px 0;padding:8px 10px;border:1px dashed currentColor;border-radius:8px;';
    var msg = el('p', 'ev-msg', _t('js.pad.ev.asking', 'Asking Pepe for the audio…'));
    msg.setAttribute('role', 'status');
    card.appendChild(msg);
    card.appendChild(el('p', 'ev-note', _t('js.pad.ev.note', 'Never posted · kept 30 days · every evidence clip is logged')));
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(card, anchor.nextSibling); else document.body.appendChild(card);
    var id = null, tries = 0, closed = false;
    function close() { if (closed) return; closed = true; if (card.parentNode) card.parentNode.removeChild(card); if (done) done(); }
    function failed(text) {
      msg.textContent = text;
      var x = el('button', 'ds-btn sm', _t('js.pad.ev.close', 'Close'));
      x.type = 'button';
      x.addEventListener('click', close);
      card.appendChild(x);
    }
    function ready(d) {
      msg.textContent = _t('js.pad.ev.ready', 'Listen, then save it or discard it.');
      var au = el('audio');
      au.controls = true; au.preload = 'none'; au.src = d.audio;
      au.style.cssText = 'display:block;width:100%;max-width:420px;margin:6px 0;';
      card.insertBefore(au, msg.nextSibling);
      var lab = el('label', 'ev-reason');
      lab.appendChild(document.createTextNode(_t('js.pad.ev.reason', 'Reason (optional)') + ' '));
      var inp = el('input', 'ds-in');
      inp.type = 'text'; inp.maxLength = 200; inp.autocomplete = 'off';
      lab.appendChild(inp);
      card.appendChild(lab);
      var row = el('div', 'ev-actions');
      var save = el('button', 'ds-btn sm', _t('js.pad.ev.save', 'Save'));
      var drop = el('button', 'ds-btn sm ghost', _t('js.pad.ev.discard', 'Discard'));
      save.type = 'button'; drop.type = 'button';
      row.appendChild(save); row.appendChild(document.createTextNode(' ')); row.appendChild(drop);
      card.appendChild(row);
      save.addEventListener('click', function () {
        save.disabled = true; drop.disabled = true;
        req('POST', base + '/' + id + '/save', { reason: inp.value }).then(function (r) {
          au.pause(); au.removeAttribute('src');
          card.removeChild(au); card.removeChild(lab); card.removeChild(row);
          msg.textContent = _t('js.pad.ev.saved', 'Saved as evidence - kept until {date}.', { date: day(r.expires_at) });
          var x = el('button', 'ds-btn sm', _t('js.pad.ev.close', 'Close'));
          x.type = 'button';
          x.addEventListener('click', close);
          card.appendChild(x);
        }).catch(function (e) { save.disabled = false; drop.disabled = false; msg.textContent = _t('js.pad.ev.err', 'Couldn’t save it: {error}', { error: e.message }); });
      });
      drop.addEventListener('click', function () {
        drop.disabled = true; save.disabled = true;
        req('POST', base + '/' + id + '/discard', {}).then(close, close);
      });
    }
    function poll() {
      if (closed) return;
      tries++;
      req('GET', base + '/' + id).then(function (d) {
        if (d.state === 'ready' && d.audio) return ready(d);
        if (d.state === 'pending' && tries < 50) return setTimeout(poll, 1500);
        failed(_t('js.pad.ev.failed', 'Couldn’t get the audio: {error}', { error: d.status || d.state }));
      }).catch(function (e) { failed(_t('js.pad.ev.failed', 'Couldn’t get the audio: {error}', { error: e.message })); });
    }
    req('POST', base, { c: c }).then(function (d) { id = d.id; setTimeout(poll, 1200); })
      .catch(function (e) { failed(_t('js.pad.ev.failed', 'Couldn’t get the audio: {error}', { error: e.message })); });
    return { close: close };
  }

  /** Pad settings: the pad's evidence clips (its owner only - the server refuses anyone else). */
  function list(box) {
    var slug = box.getAttribute('data-slug');
    box.textContent = _t('js.pad.ev.loading', 'Loading…');
    req('GET', '/api/evidence?room=' + encodeURIComponent(slug)).then(function (d) {
      box.textContent = '';
      var rows = d.rows || [];
      if (!rows.length) { box.appendChild(el('p', 'ds-meta', _t('js.pad.ev.empty', 'No evidence clips on this pad.'))); return; }
      var ul = el('ul', 'ev-list');
      ul.style.cssText = 'list-style:none;padding:0;margin:0;';
      rows.forEach(function (r) {
        var li = el('li', 'ev-row');
        li.style.cssText = 'padding:6px 0;border-top:1px solid rgba(127,127,127,.25);';
        li.appendChild(el('div', 'ev-head', _t('js.pad.ev.row', '{when} · {who} ({veil}) · {secs} s · saved by {by} · kept until {until}',
          { when: when(r.said_at), who: r.subject, veil: r.veil + (r.tx ? ', transcripts off' : ''), secs: Math.round(r.secs || 0), by: r.by || '?', until: day(r.expires_at) })));
        if (r.reason) li.appendChild(el('div', 'ds-meta', r.reason));
        // (review fix WP5-ACC-8: whether the subject used forget-me or deleted their account is never shown to a pad's owner - the
        // server sends subject_gone to admins only)
        var b = el('button', 'ds-btn sm', _t('js.pad.ev.play', 'Play'));
        b.type = 'button';
        b.addEventListener('click', function () {
          var au = el('audio');
          au.controls = true; au.preload = 'none'; au.src = r.audio;
          au.style.cssText = 'display:block;width:100%;max-width:420px;margin:4px 0;';
          b.replaceWith(au);
          try { au.play(); } catch (e) { /* the controls are there */ }
        });
        li.appendChild(b);
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }).catch(function (e) { box.textContent = _t('js.pad.ev.list_err', 'Couldn’t load the evidence clips: {error}', { error: e.message }); });
  }

  window.PATVPadEvidence = { open: open, list: list };
  function boot() { var box = document.getElementById('evidenceList'); if (box && window.fetch) list(box); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
