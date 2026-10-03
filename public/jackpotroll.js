// Jackpot roll reveal — shared by the gold wheel (script.js) and the public/OBS wheel (publicwheel.js).
// The SERVER already rolled the percent (jackpotPct) when the spin was made; this only animates it:
// a meter of the roll's bands, cool → hot, with a needle that sweeps back and forth, slows, and
// settles on the rolled band, then the PAT amount counts up. Bands match JACKPOT_TIERS in index.js.
(function () {
  const BANDS = [
    { lo: 2,   hi: 6,   label: '2–6%',   color: '#3A86FF' },
    { lo: 6,   hi: 14,  label: '6–14%',  color: '#2EC4B6' },
    { lo: 14,  hi: 28,  label: '14–28%', color: '#8AC926' },
    { lo: 28,  hi: 50,  label: '28–50%', color: '#FFCA3A' },
    { lo: 50,  hi: 75,  label: '50–75%', color: '#FF924C' },
    { lo: 75,  hi: 99,  label: '75–99%', color: '#FF595E' },
    { lo: 100, hi: 100, label: 'GRAND',  color: '#FFD700' },
  ];

  const css = `
  #jpRoll { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
            z-index:120; pointer-events:none; }
  #jpRoll .jp-panel { width:92%; padding:22px 18px 18px; border-radius:18px; background:rgba(10,8,20,.88);
            box-shadow:0 0 40px rgba(255,215,0,.55), inset 0 0 0 3px #FFD700; text-align:center;
            font-family:'Press Start 2P', monospace; color:#FFD700; }
  #jpRoll .jp-title { font-size:22px; letter-spacing:3px; margin-bottom:22px; text-shadow:0 0 12px #FFD700; }
  #jpRoll .jp-meter { position:relative; display:flex; height:54px; border-radius:10px; overflow:visible; }
  #jpRoll .jp-band { flex:1; display:flex; align-items:flex-end; justify-content:center; padding-bottom:4px;
            font-size:9px; color:rgba(0,0,0,.75); border-right:2px solid rgba(10,8,20,.9);
            transition:filter .2s, transform .2s; }
  #jpRoll .jp-band:first-child { border-radius:10px 0 0 10px; }
  #jpRoll .jp-band:last-child { border-radius:0 10px 10px 0; border-right:0; }
  #jpRoll .jp-band.dim { filter:brightness(.35) saturate(.6); }
  #jpRoll .jp-band.win { transform:scaleY(1.18); filter:brightness(1.25); box-shadow:0 0 22px var(--c); }
  #jpRoll .jp-needle { position:absolute; top:-16px; bottom:-10px; width:4px; margin-left:-2px; background:#fff;
            border-radius:2px; box-shadow:0 0 10px #fff, 0 0 20px #FFD700; }
  #jpRoll .jp-needle::before { content:''; position:absolute; top:-12px; left:-8px; border:10px solid transparent;
            border-top-color:#fff; }
  #jpRoll .jp-pct { font-size:40px; margin-top:24px; color:#fff; text-shadow:0 0 14px #FFD700; min-height:44px; }
  #jpRoll .jp-amt { font-size:20px; margin-top:14px; min-height:24px; letter-spacing:2px; }
  #jpRoll.grand .jp-panel { animation:jpGrand .5s ease-in-out infinite alternate; }
  @keyframes jpGrand { from { box-shadow:0 0 30px #FFD700, inset 0 0 0 3px #FFD700; }
                       to   { box-shadow:0 0 90px #FFD700, inset 0 0 0 6px #fff; } }
  @media (prefers-reduced-motion: reduce) { #jpRoll.grand .jp-panel { animation:none; } }
  `;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // Needle position (0..1 across the meter) for a percent: equal-width bands, linear inside each.
  function posFor(pct) {
    if (pct >= 100) return (BANDS.length - 0.5) / BANDS.length;
    let i = BANDS.findIndex(b => pct < b.hi);
    if (i < 0) i = BANDS.length - 2;
    const b = BANDS[i];
    const f = Math.min(1, Math.max(0, (pct - b.lo) / Math.max(1, b.hi - b.lo)));
    return (i + 0.1 + 0.8 * f) / BANDS.length;
  }
  // Percent shown while the needle is at x (inverse of posFor, for the live readout).
  function pctAt(x) {
    const i = Math.min(BANDS.length - 1, Math.max(0, Math.floor(x * BANDS.length)));
    const b = BANDS[i];
    if (b.lo === b.hi) return b.lo;
    const f = Math.min(1, Math.max(0, (x * BANDS.length - i - 0.1) / 0.8));
    return Math.round(b.lo + f * (b.hi - b.lo));
  }

  let timer = null;

  window.hideJackpotRoll = function () {
    if (timer) { cancelAnimationFrame(timer); timer = null; }
    const old = document.getElementById('jpRoll');
    if (old) old.remove();
  };

  // pct: the server's rolled percent (integer), amount: PAT won, grand: whole jackpot.
  window.showJackpotRoll = function (pct, amount, grand, tick) {
    window.hideJackpotRoll();
    if (!document.getElementById('jpRollCss')) {
      const st = el('style'); st.id = 'jpRollCss'; st.textContent = css; document.head.appendChild(st);
    }
    const host = document.querySelector('.wheel-container') || document.body;
    const root = el('div'); root.id = 'jpRoll';
    const panel = el('div', 'jp-panel');
    panel.appendChild(el('div', 'jp-title', '🏆 JACKPOT ROLL 🏆'));
    const meter = el('div', 'jp-meter');
    const bandEls = BANDS.map(b => {
      const d = el('div', 'jp-band', b.label);
      d.style.background = b.color;
      d.style.setProperty('--c', b.color);
      meter.appendChild(d);
      return d;
    });
    const needle = el('div', 'jp-needle');
    meter.appendChild(needle);
    panel.appendChild(meter);
    const pctEl = el('div', 'jp-pct', '');
    const amtEl = el('div', 'jp-amt', '');
    panel.appendChild(pctEl); panel.appendChild(amtEl);
    root.appendChild(panel);
    host.appendChild(root);

    const target = grand ? posFor(100) : posFor(Math.max(2, Math.min(99, pct || 2)));
    const winBand = Math.min(BANDS.length - 1, Math.floor(target * BANDS.length));
    // Path: sweep right, back left, right again, then ease onto the target — ping-pong over a
    // total distance of 3 full widths + the target, decelerating the whole way.
    const total = 3 + (1 - target);   // R, L, R to the far end, then back left onto the target
    const dur = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 5200;
    const unfold = d => {             // distance along the ping-pong → position in [0,1]
      const m = d % 2;
      return m <= 1 ? m : 2 - m;
    };
    let lastBand = -1;
    const start = performance.now();

    function finish() {
      needle.style.left = (target * 100) + '%';
      bandEls.forEach((b, i) => b.classList.toggle(i === winBand ? 'win' : 'dim', true));
      pctEl.textContent = grand ? 'GRAND!' : (pct + '%');
      if (grand) root.classList.add('grand');
      const t0 = performance.now(), countMs = dur ? 1600 : 0;
      (function count(now) {
        const f = countMs ? Math.min(1, (now - t0) / countMs) : 1;
        const shown = Math.round(amount * (1 - Math.pow(1 - f, 3)));
        amtEl.textContent = 'PAT ' + shown.toLocaleString();
        if (f < 1) timer = requestAnimationFrame(count);
      })(t0);
    }

    function frame(now) {
      const t = dur ? Math.min(1, (now - start) / dur) : 1;
      const eased = 1 - Math.pow(1 - t, 3);
      const x = unfold(eased * total);
      needle.style.left = (x * 100) + '%';
      pctEl.textContent = (x >= (BANDS.length - 1) / BANDS.length) ? 'GRAND?' : (pctAt(x) + '%');
      const band = Math.min(BANDS.length - 1, Math.floor(x * BANDS.length));
      if (band !== lastBand) {
        lastBand = band;
        if (tick) { try { tick.pause(); tick.currentTime = 0; tick.play(); } catch (e) {} }
      }
      if (t < 1) timer = requestAnimationFrame(frame); else finish();
    }
    timer = requestAnimationFrame(frame);
  };
})();
