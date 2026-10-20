// The pad chat's inline renderer exactly as views/room.ejs shipped it before CL5 (git d6263ec9, lines 854-958): the
// frozen oracle for test/chatlog-render.test.js - CL5's public/js/chatlog-core.js must build the same DOM for every fixture.
// Generated from that commit's room.ejs; never edit by hand.
"use strict";
module.exports = function legacy(document, _t) {
    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
    function avatar(u) {
      if (u && u.patv && u.patv.avatar) { var im = el('img', 'av'); im.src = u.patv.avatar; im.alt = ''; im.loading = 'lazy'; return im; }
      var nobody = !u || u.anon || u.former;          // CL3: "former member" (a web member whose account is gone) has no look
      var d = el('span', 'av' + (nobody ? ' anon' : ''), nobody ? '?' : (u.display || u.login || '?').charAt(0).toUpperCase());
      if (!nobody) d.style.background = 'hsl(' + hue(u.login || '') + ',55%,62%)';
      d.setAttribute('aria-hidden', 'true');
      return d;
    }
    function name(u) {
      if (!u || u.anon) return el('span', 'who', _t('js.pad.someone', 'someone'));
      if (u.former) return el('span', 'who', _t('js.pad.chat.former', 'former member'));
      var n;
      if (u.patv) { n = el('a', 'who'); n.href = '/u/' + encodeURIComponent(u.patv.username); n.textContent = u.display || u.login; }
      else n = el('span', 'who', u.display || u.login);
      if (u.patv && u.patv.style) { n.classList.add('cx-name'); n.style.cssText = u.patv.style; }
      if (u.self) n.title = 'Pepe'; else if (u.display && u.login && !u.acct && u.display.toLowerCase() !== u.login.toLowerCase()) n.title = u.login;
      // 1.99xa: a line they sent from the website (Pepe relayed it) - their own chat, marked so the room can tell
      if (u.web) {
        var wrap = el('span', 'who-web'); wrap.appendChild(n);
        var mk = el('span', 'web-mark', '\u00a0\ud83c\udf10'); mk.title = _t('js.pad.chat.web', 'Sent from the website'); wrap.appendChild(mk);
        return wrap;
      }
      return n;
    }
    // 1.99ir: their flair in this pad (padflair.js) - text only, colours must be strict hex
    function flairEl(u) {
      var f = u && !u.anon && u.patv && u.patv.flair;
      if (!f || !f.name) return null;
      var s = el('span', 'ufl');
      s.title = _t('js.pad.flair', 'Pad flair: {name}', { name: f.name });
      if (f.emoji) s.appendChild(el('span', 'ufl-e', f.emoji));
      s.appendChild(el('span', 'ufl-n', f.name));     // 1.99xm: its own span so a long name ellipsizes
      if (/^#[0-9a-f]{6}$/.test(f.color || '')) s.style.setProperty('--fl', f.color);
      if (/^#[0-9a-f]{6}$/.test(f.ink || '')) s.style.setProperty('--fli', f.ink);
      return s;
    }
    function hhmm(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
    function dur(ms) { var s = Math.round(ms / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : (s / 3600).toFixed(1) + 'h'; }
    function label(u) { return !u || u.anon ? _t('js.pad.someone', 'someone') : u.former ? _t('js.pad.chat.former', 'former member') : (u.display || u.login); }
    // CL3: a window in words - "15 minutes", "24 hours", "7 days" (spanOf) and short for the chip - "15 min", "24 h", "7 d"
    var SPAN_D = { one: '{count} day', other: '{count} days' }, SPAN_H = { one: '{count} hour', other: '{count} hours' }, SPAN_M = { one: '{count} minute', other: '{count} minutes' };
    function spanOf(s) {
      if (s % 86400 === 0 && s >= 172800) return _t('js.pad.chat.span_d', SPAN_D, { count: s / 86400 });
      if (s % 3600 === 0) return _t('js.pad.chat.span_h', SPAN_H, { count: s / 3600 });
      return _t('js.pad.chat.span_min', SPAN_M, { count: Math.max(1, Math.round(s / 60)) });
    }
    function chipSpan(s) {
      if (s % 86400 === 0 && s >= 172800) return _t('js.pad.chat.chip_d', '{n} d', { n: s / 86400 });
      if (s % 3600 === 0) return _t('js.pad.chat.chip_h', '{n} h', { n: s / 3600 });
      return _t('js.pad.chat.chip_min', '{n} min', { n: Math.max(1, Math.round(s / 60)) });
    }
    // CL3: 📜 a pad's chat-history settings line (padchat.js / chatlogview.js; minimal until the shared renderer, CL5)
    function noteText(it) {
      if (it.w === 'window') return it.s == null ? _t('js.pad.chat.note_all', '📜 Chat history on this pad: everything it keeps')
        : it.s === 0 ? _t('js.pad.chat.note_off', '📜 Chat history on this pad: off') : _t('js.pad.chat.note_window', '📜 Chat history on this pad: last {span}', { span: spanOf(it.s) });
      if (it.w === 'search') return it.s ? _t('js.pad.chat.note_search_on', '📜 Search is on again on this pad, for lines said from now on') : _t('js.pad.chat.note_search_off', '📜 Search is now off on this pad');
      if (it.w === 'open') {
        var day = '';
        try { day = new Date(it.o).toLocaleDateString(document.documentElement.lang || undefined, { day: 'numeric', month: 'long' }); } catch (e) { day = new Date(it.o).toDateString(); }
        return _t('js.pad.chat.note_open', '📜 Earlier history opens on {date}', { date: day });
      }
      if (it.w === 'open_done') return _t('js.pad.chat.note_open_done', '📜 Earlier history is open on this pad now');
      return null;
    }

    function item(it) {
      if (it.k === 'msg' || it.k === 'tx') {
        var row = el('div', 'line' + (it.k === 'tx' ? ' tx' : '') + (it.u && it.u.self ? ' pepe' : ''));
        if (it.k === 'tx') row.title = _t('js.pad.chat.tx', 'Said on the mic (auto-transcribed)');
        // 1.99fp: what ✂️ Clip chat / 🔊 Clip read (public/js/chat-clip.js) - the server re-reads its own copy by id
        if (it.c) row.setAttribute('data-c', it.c);
        row.setAttribute('data-k', it.k); row.setAttribute('data-name', label(it.u)); row.setAttribute('data-text', it.text);
        if (it.k === 'tx' && it.id) row.setAttribute('data-tx', it.id);
        row.appendChild(avatar(it.u));
        var b = el('div', 'body');
        b.appendChild(name(it.u));
        var fl_ = flairEl(it.u); if (fl_) { b.appendChild(fl_); b.appendChild(document.createTextNode(' ')); }
        b.appendChild(document.createTextNode(it.k === 'tx' ? '\u201c' + it.text + '\u201d' : it.text));
        var t = el('time', 'when', hhmm(it.ts)); t.dateTime = new Date(it.ts).toISOString();
        b.appendChild(t);
        row.appendChild(b);
        return row;
      }
      if (it.k === 'live') {
        // 1.99kp: 🎥 a stream started on this pad's stage (golive.js -> bridge.liveNotice)
        var lv = el('div', 'sys live');
        // 1.99lr: np = a 📼 queue's next title
        var lt = it.np ? _t('js.pad.chat.np', '📼 Now playing on {pad}: {what}', { pad: it.pad, what: it.what })
          : it.what ? _t('js.pad.chat.live_what', '🎥 {name} just went live on {pad} — {what}', { name: it.who, pad: it.pad, what: it.what })
          : _t('js.pad.chat.live', '🎥 {name} just went live on {pad}', { name: it.who, pad: it.pad });
        if (it.link) { var la = el('a', null, lt); la.href = it.link; lv.appendChild(la); } else lv.appendChild(document.createTextNode(lt));
        lv.appendChild(document.createTextNode(' · ' + hhmm(it.ts)));
        return lv;
      }
      if (it.k === 'note') { var nt = noteText(it); return nt ? el('div', 'sys note', nt + ' · ' + hhmm(it.ts)) : null; }
      var txt = it.k === 'join' ? _t('js.pad.chat.joined', '→ {name} joined', { name: label(it.u) })
        : it.k === 'leave' ? _t('js.pad.chat.left', '← {name} left', { name: label(it.u) })
        : it.k === 'mic' ? _t('js.pad.chat.mic', '🎙️ {name} grabbed the mic', { name: label(it.u) })
        : it.k === 'unmic' ? (it.ms ? _t('js.pad.chat.unmic_after', '🎙️ {name} dropped the mic after {dur}', { name: label(it.u), dur: dur(it.ms) }) : _t('js.pad.chat.unmic', '🎙️ {name} dropped the mic', { name: label(it.u) }))
        : it.k === 'topic' ? _t('js.pad.chat.topic', '📌 topic: {text}', { text: it.text }) : null;
      if (!txt) return null;
      return el('div', 'sys' + (it.k === 'topic' ? ' topic' : ''), txt + ' · ' + hhmm(it.ts));
    }

    return { item: item, avatar: avatar, name: name, label: label, hhmm: hhmm, chipSpan: chipSpan };
};
