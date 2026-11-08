// casino-sound.js — the themed tables' opt-in sound cues (hand-off 20, decision 5). Loaded by a table page only when its table
// has a theme (views/casino-hm.ejs); casino-ui.js CZ.theme calls CZSound.update(themeId, tableView) on every render.
//   * OFF by default, per viewer: a 🔇 / 🔊 toggle in the table's header, remembered in localStorage "cz-sound" (every access in
//     try/catch - a private window just keeps it for the page);
//   * never before a click: the AudioContext is made (or resumed) only inside a click / key press on the page, and only while the
//     toggle is on; no ambience loop;
//   * WebAudio-synthesised, nothing downloaded: a chip clack (a bet goes in), a card slide (cards dealt), a bell (a hand / round
//     is won). One cue per state change, never one per poll (the first state seen only sets the baseline).
// Strings: CZ.T("js.casino.sound_*", English default = locales/en.json).
(function () {
  "use strict";
  const CZ = window.CZ;
  if (!CZ) return;
  const tr = CZ.T;
  const T = (k, d) => (tr ? tr(k, d) : d);
  const KEY = "cz-sound";
  function stored() { try { return window.localStorage.getItem(KEY) === "1"; } catch (e) { return false; } }
  function remember(v) { try { window.localStorage.setItem(KEY, v ? "1" : "0"); } catch (e) { /* blocked storage: this page only */ } }
  let on = stored(), gesture = false, ac = null, btn = null, sig = null, noiseBuf = null;

  /** the AudioContext - made or resumed only from a gesture handler (WebKit unlocks audio there) */
  function wake() {
    if (!on) return null;
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ac = new AC(); } catch (e) { ac = null; return null; }
    }
    try { if (ac.state === "suspended" && ac.resume) { const p = ac.resume(); if (p && p.catch) p.catch(() => {}); } } catch (e) { /* ignore */ }
    return ac;
  }
  function onGesture() { gesture = true; if (on) wake(); }
  document.addEventListener("pointerdown", onGesture, true);
  document.addEventListener("keydown", onGesture, true);

  // ── the cues ──
  function noise(c) {
    if (noiseBuf) return noiseBuf;
    const len = Math.max(1, Math.floor((c.sampleRate || 44100) * 0.4));
    noiseBuf = c.createBuffer(1, len, c.sampleRate || 44100);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }
  function burst(c, at, freq, q, peak, dur, sweepTo) {
    const src = c.createBufferSource();
    src.buffer = noise(c);
    const f = c.createBiquadFilter();
    f.type = "bandpass"; f.Q.value = q;
    f.frequency.setValueAtTime(freq, at);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, at + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(c.destination);
    src.start(at);
    src.stop(at + dur + 0.02);
  }
  function tone(c, at, freq, peak, dur) {
    const o = c.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(freq, at);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(c.destination);
    o.start(at);
    o.stop(at + dur + 0.05);
  }
  const CUES = {
    chip: (c, t) => { burst(c, t, 3400, 7, 0.22, 0.05); burst(c, t + 0.07, 2900, 7, 0.16, 0.05); },                 // two clay chips clack
    card: (c, t) => { burst(c, t, 1400, 1.2, 0.12, 0.16, 4200); },                                                     // a card slides
    bell: (c, t) => { tone(c, t, 1318.5, 0.14, 1.4); tone(c, t, 2637, 0.05, 0.9); tone(c, t, 3951, 0.025, 0.5); },    // the bar's bell
  };
  function play(name) {
    if (!on || !gesture || !ac || !CUES[name]) return;
    try { CUES[name](ac, (ac.currentTime || 0) + 0.01); } catch (e) { /* a broken audio stack never breaks the table */ }
  }

  // ── what changed: one cue per change of the table's state ──
  function sigOf(t) {
    const lr = t && t.last_round;
    if (t && t.game === "holdem") {
      const down = (t.seats || []).filter((s) => s && s.cards_down).length * 2;
      return { hand: t.hand_no || 0, cards: (t.board || []).length + down, chips: Number(t.pot) || 0, done: lr ? lr.hand_no : null };
    }
    let cards = t && t.dealer && t.dealer.cards ? t.dealer.cards.length : 0, chips = 0;
    for (const s of (t && t.seats) || []) { chips += Number(s.bet) || 0; for (const h of s.hands || []) cards += (h.cards || []).length; }
    return { hand: (t && t.round_no) || 0, cards, chips, done: lr ? lr.round_no : null };
  }
  function cueFor(a, b) {
    if (b.done != null && b.done !== a.done) return "bell";
    if (b.cards > a.cards || (b.hand !== a.hand && b.cards > 0)) return "card";
    if (b.chips > a.chips && b.hand === a.hand) return "chip";
    return null;
  }

  // ── the toggle ──
  function paint() {
    if (!btn) return;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? T("sound_on", "Table sounds on (chips, cards, a bell on a win)") : T("sound_off", "Table sounds off");
    btn.textContent = (on ? "🔊 " : "🔇 ") + T("sound_btn", "Sound");
  }
  function button() {
    if (btn) return btn;
    const bar = document.querySelector(".cz-bar");
    if (!bar) return null;
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cz-pill";
    btn.id = "cz-soundbtn";
    btn.setAttribute("aria-label", T("sound_label", "Table sounds"));
    btn.addEventListener("click", () => {
      gesture = true;
      on = !on;
      remember(on);
      paint();
      if (on) wake();
    });
    const ref = document.getElementById("cz-histbtn");
    if (ref && ref.parentNode === bar) bar.insertBefore(btn, ref); else bar.appendChild(btn);
    paint();
    return btn;
  }

  /** every render: the theme the table shows and its public view */
  function update(id, t) {
    if (!id || id === "classic") { if (btn) btn.hidden = true; sig = null; return; }
    const b = button();
    if (b) b.hidden = false;
    const next = sigOf(t || {});
    const prev = sig;
    sig = next;
    if (!prev || !on || !gesture) return;
    const cue = cueFor(prev, next);
    if (cue) play(cue);
  }

  window.CZSound = { update, enabled: () => on };
})();
