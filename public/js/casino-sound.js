// casino-sound.js — the themed tables' opt-in sound cues (hand-off 20, decision 5). Loaded by a table page only when its table
// has a theme (views/casino-hm.ejs, casino-bj.ejs); casino-ui.js CZ.theme calls CZSound.update(themeId, tableView) on every render.
//   * OFF by default, per viewer: a 🔇 / 🔊 toggle in the table's own top row (beside "All tables" - h20 verify: never another
//     pill in the page header, which wrapped it and pushed the table down), remembered in localStorage "cz-sound" (every access in
//     try/catch - a private window just keeps it for the page);
//   * never before a click: the AudioContext is made (or resumed) only inside a click / key press on the page, and only while the
//     toggle is on; no ambience loop;
//   * WebAudio-synthesised, nothing downloaded: a chip clack (a bet goes in), a card slide (cards dealt), a bell (a hand / round
//     is won). One cue per state change, never one per poll (the first state seen only sets the baseline).
// Strings: CZ.T("js.casino.sound_*", English default = locales/en.json).
// 1.99aoj (O13(4)): the roulette table (always the classic look) has the toggle too, and its own cues - the ball rolling off
// the croupier's hand, a diamond's tick, the clack of a fret hop, the settle - played at the moments the wheel (casino/rlwheel.js
// onEvent) shows them, plus the chip clack and the bell on a win (casinorl.js calls CZSound.cue). Same rules: off by default, never
// before a gesture, nothing downloaded; under reduced motion only the settle and the bell.
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
  // (1.99aoj review: a touch's pointerdown is not a user activation in WebKit - its pointerup / touchend / click are, so a sound
  // left on unlocks on the first tap on an iPhone instead of after toggling Sound off and on)
  for (const type of ["pointerdown", "pointerup", "touchend", "click", "keydown"]) document.addEventListener(type, onGesture, true);

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
    // 1.99aoj: the wheel's own moments (quiet - a ball, not a bell)
    rl_launch: (c, t) => { burst(c, t, 700, 0.8, 0.05, 1.1, 1900); },                                                  // the ball rolls off the hand
    rl_drop: (c, t) => { burst(c, t, 1900, 1.1, 0.05, 0.35, 900); },                                                   // it leaves the track
    rl_diamond: (c, t) => { burst(c, t, 4600, 9, 0.12, 0.03); },                                                       // a diamond's tick
    rl_rotor: (c, t) => { burst(c, t, 2500, 6, 0.14, 0.045); },                                                        // onto the rotor
    rl_hop: (c, t) => { burst(c, t, 2900, 7, 0.1, 0.035); },                                                           // a fret clack
    rl_settle: (c, t) => { burst(c, t, 2400, 6, 0.16, 0.05); burst(c, t + 0.09, 2700, 7, 0.08, 0.04); },              // home in the pocket
  };
  function play(name) {
    if (!on || !gesture || !ac || !CUES[name]) return;
    try { CUES[name](ac, (ac.currentTime || 0) + 0.01); } catch (e) { /* a broken audio stack never breaks the table */ }
  }
  // 1.99aoj: a cue the table asks for (casinorl.js) - a background tab plays nothing; a run of hops is at most one clack per 60 ms
  const reduced = () => { try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; } };
  let lastCueAt = 0;
  function cue(name) {
    if (!on || !gesture || document.hidden || !CUES[name]) return;
    if (reduced() && name !== "bell" && name !== "rl_settle") return;
    const now = Date.now();
    if (/^rl_(?:hop|diamond)$/.test(name) && now - lastCueAt < 60) return;
    lastCueAt = now;
    // (never makes the AudioContext itself: a cue runs from a frame callback, outside any gesture - WebKit would leave it suspended)
    play(name);
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

  // ── the toggle: in the table's own top row, right after "All tables" (h20 verify review: an extra pill in the page header
  // wrapped it onto another row and pushed the table under the action bar); casino-themes.css floats it to the row's end ──
  let icon = null, label = null;
  let roulette = false;
  function paint() {
    if (!btn) return;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? (roulette ? T("sound_on_rl", "Table sounds on (chips, the ball, a bell on a win)") : T("sound_on", "Table sounds on (chips, cards, a bell on a win)")) : T("sound_off", "Table sounds off");
    icon.textContent = on ? "🔊" : "🔇";
    label.textContent = T("sound_btn", "Sound");
  }
  function button() {
    if (btn) return btn;
    const back = document.querySelector("#cz-table > .back");
    if (!back || !back.parentNode) return null;
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cz-pill cz-snd";
    btn.id = "cz-soundbtn";
    btn.setAttribute("aria-label", T("sound_label", "Table sounds"));
    icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    label = document.createElement("span");
    label.className = "cz-snd-l";                     // (phones: hidden - the icon only)
    btn.appendChild(icon);
    btn.appendChild(label);
    btn.addEventListener("click", () => {
      gesture = true;
      on = !on;
      remember(on);
      paint();
      if (on) wake();
    });
    back.parentNode.insertBefore(btn, back.nextSibling);
    paint();
    return btn;
  }

  /** every render: the theme the table shows and its public view */
  function update(id, t) {
    // (1.99aoj: a roulette wheel - classic - has the toggle; its cues come from cue(), never from this state diff)
    if (t && t.game === "roulette") { roulette = true; const b = button(); if (b) { b.hidden = false; paint(); } sig = null; return; }
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

  window.CZSound = { update, cue, enabled: () => on };
})();
