// Public/OBS wheel (views/publicwheel.ejs, /g/wheel). Arcade look in /public/css/obs-wheel.css.
const canvas = document.getElementById('wheelCanvas');
const ctx = canvas.getContext('2d');
const wheelFrame = document.getElementById('wheelFrame');

// Draw at 2x so the wheel stays crisp when OBS scales the source up to 1080p; the drawing code
// below keeps working in the canvas's 500x500 logical space.
const LOGICAL = canvas.width;
const HIDPI = 2;
canvas.width = LOGICAL * HIDPI;
canvas.height = LOGICAL * HIDPI;
// The 2x transform is applied at the top of every drawWheel(), not once here: when Chromium/CEF
// loses the 2D context (GPU/renderer crash, out of memory) and restores it, ALL context state is
// reset - a one-off ctx.scale() is gone and the wheel came back drawn at 500px in the 1000px
// backing store: a quarter-size disc in the top-left of the ring.
canvas.addEventListener('contextrestored', () => drawWheel());

// Load the audio file at the start of the script
const tickerSound = new Audio('/public/wheel.ogg');

// Arrow element
const arrow = document.createElement('div');
arrow.id = 'arrow';
document.querySelector('.wheel-container').appendChild(arrow);

// Center image
const centerImage = document.createElement('img');
centerImage.id = 'centerImage';
centerImage.alt = '';
document.querySelector('.wheel-container').appendChild(centerImage);

// Set your custom image or GIF URL
centerImage.src = '/public/img/star.gif';

const wheelRadius = LOGICAL / 2;
const centerX = LOGICAL / 2;
const centerY = LOGICAL / 2;

const multiplier = 1.10;   // same as the server's PUBLIC_WHEEL_MULTIPLIER

// Set the Wheel Prizes
let segments = [
  { color: '#FF6347', label: String(Math.round(2700 * multiplier)), size: 1 },
  { color: '#FFD700', label: String(Math.round(5350 * multiplier)), size: 1 },
  { color: '#ADFF2F', label: String(Math.round(3650 * multiplier)), size: 1 },
  { color: '#00FA9A', label: String(Math.round(7750 * multiplier)), size: 0.9 },
  { color: '#1E90FF', label: String(Math.round(700 * multiplier)), size: 1 },
  { color: '#EE82EE', label: String(Math.round(0 * multiplier)), size: 1 },
  { color: '#FF69B4', label: String(Math.round(22500 * multiplier)), size: 0.5 },
  { color: '#20B2AA', label: String(Math.round(920 * multiplier)), size: 1 },
  { color: '#FFA500', label: String(Math.round(5950 * multiplier)), size: 1 },
  { color: '#B22222', label: String(Math.round(4550 * multiplier)), size: 1 },
  { color: '#8A2BE2', label: String(Math.round(4100 * multiplier)), size: 1 },
  { color: '#5F9EA0', label: String(Math.round(1400 * multiplier)), size: 1 },
  { color: '#EE82EE', label: String(Math.round(0 * multiplier)), size: 1 },
  { color: '#FFD700', label: String(Math.round(46000 * multiplier)), size: 0.1 },
  { color: '#DB7093', label: String(Math.round(2250 * multiplier)), size: 1 },
  { color: '#3CB371', label: String(Math.round(430 * multiplier)), size: 1 },
  { color: '#4682B4', label: String(Math.round(1850 * multiplier)), size: 1 },
  { color: '#FF1493', label: String(Math.round(11500 * multiplier)), size: 0.8 },
  { color: '#00CED1', label: String(Math.round(0 * multiplier)), size: 1 },
  { color: '#FFD700', label: String(Math.round(6900 * multiplier)), size: 1 },
  { color: '#3CB371', label: String(Math.round(4950 * multiplier)), size: 1 },
  { color: '#4682B4', label: String(Math.round(3250 * multiplier)), size: 1 },
  { color: '#FF1493', label: String(Math.round(8200 * multiplier)), size: 1 },
  { color: '#8A2BE2', label: String(Math.round(9200 * multiplier)), size: 1 },
  { color: '#00CED1', label: String(Math.round(0 * multiplier)), size: 1 },
  { color: '#FFD700', label: '🏆 JACKPOT 🏆', size: 0.00777, jackpot: true }
];

let currentAngle = 0 - ((2 * Math.PI) / 4);
let isSpinning = false;

// Draws the Wheel
function drawWheel() {
  ctx.setTransform(HIDPI, 0, 0, HIDPI, 0, 0);
  ctx.clearRect(0, 0, LOGICAL, LOGICAL);

  const totalSize = segments.reduce((acc, seg) => acc + seg.size, 0);
  let angleStart = currentAngle;

  segments.forEach((segment) => {
    const angleEnd = angleStart + (segment.size / totalSize) * 2 * Math.PI;

    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.arc(centerX, centerY, wheelRadius, angleStart, angleEnd);
    ctx.fillStyle = segment.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (!segment.jackpot) {           // the jackpot's label is drawn by drawJackpotGlow
      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate((angleStart + angleEnd) / 2);
      ctx.textAlign = 'right';
      ctx.font = 'bold 17px Arial';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.strokeText(segment.label, wheelRadius - 12, 6);
      ctx.fillStyle = '#fff';
      ctx.fillText(segment.label, wheelRadius - 12, 6);
      ctx.restore();
    }

    angleStart = angleEnd;
  });
  drawJackpotGlow();

  // No centre disc: the slices run to the middle and the star GIF sits on top of them.
}

// The jackpot slice is a thin sliver (~1 in 3,000 spins) - drawn with a pulsing gold glow and a
// trophy at the rim so it reads on stream. The slice itself is drawn at its true size.
function drawJackpotGlow() {
  const totalSize = segments.reduce((acc, seg) => acc + seg.size, 0);
  let a0 = currentAngle;
  for (const seg of segments) {
    const a1 = a0 + (seg.size / totalSize) * 2 * Math.PI;
    if (seg.jackpot) {
      const mid = (a0 + a1) / 2;
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 250);
      ctx.save();
      ctx.shadowColor = '#FFD700';
      ctx.shadowBlur = 12 + 14 * pulse;
      ctx.strokeStyle = 'rgba(255, 236, 140, ' + (0.75 + 0.25 * pulse) + ')';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(centerX + wheelRadius * Math.cos(mid), centerY + wheelRadius * Math.sin(mid));
      ctx.stroke();
      ctx.translate(centerX, centerY);
      ctx.rotate(mid);
      ctx.textAlign = 'right';
      ctx.font = 'bold 16px Arial';
      ctx.fillStyle = '#FFD700';
      ctx.fillText(seg.label, wheelRadius - 10, -6);
      ctx.restore();
    }
    a0 = a1;
  }
}
// Keep the glow pulsing between spins (the spin animation redraws on its own).
setInterval(() => { if (!isSpinning && segments.length) drawWheel(); }, 60);

// The server owns the slice table (/api/wheel/config) - the arrays here are only a fallback.
function loadWheelConfig(level) {
  const q = (level !== undefined && level !== null) ? ('?level=' + encodeURIComponent(level)) : '';
  return fetch('/api/wheel/config' + q)
    .then(r => r.json())
    .then(cfg => {
      if (cfg && Array.isArray(cfg.segments) && cfg.segments.length && !isSpinning) {
        segments = cfg.segments;
        drawWheel();
      }
    })
    .catch(err => console.error('wheel config fetch failed, using the built-in table:', err));
}

// Wheel Animation Function — the SERVER already decided which slice wins (targetIndex);
// we just animate the wheel so it lands there. The spin reveals the result; it no longer
// determines it. (This is the anti-forgery refactor: the client can't pick or report the prize.)
function spinWheel(wheelSpinner, spinId, targetIndex) {
  console.log("Spinning wheel for:", wheelSpinner, spinId, "target", targetIndex);
  hideResultOverlay();
  if (isSpinning) return;
  if (typeof targetIndex !== 'number' || targetIndex < 0 || targetIndex >= segments.length) {
    console.error("No/invalid targetIndex from server; aborting spin.", targetIndex);
    return;
  }
  isSpinning = true;
  setFrameState('spinning');
  showSpinner(wheelSpinner);

  const twoPi = 2 * Math.PI;
  const totalSize = segments.reduce((acc, seg) => acc + seg.size, 0);
  // Midpoint of the target slice, in the same coordinate space determineSpinResult used.
  let cumBefore = 0;
  for (let i = 0; i < targetIndex; i++) cumBefore += (segments[i].size / totalSize) * twoPi;
  const sliceFrac = (segments[targetIndex].size / totalSize) * twoPi;
  const A = cumBefore + sliceFrac / 2;
  // Solve for the final currentAngle that puts slice `targetIndex` under the arrow.
  const targetMod = (((3 * Math.PI / 2 - A) % twoPi) + twoPi) % twoPi;

  const start = currentAngle;
  const startMod = ((start % twoPi) + twoPi) % twoPi;
  const delta = (((targetMod - startMod) % twoPi) + twoPi) % twoPi;
  const extraTurns = 5; // full spins for drama before settling on the slice
  const finalAngle = start + extraTurns * twoPi + delta;

  const spinTimeTotal = 6000; // ~6s, deterministic
  const tickInterval = 2 * twoPi / segments.length;
  let lastTickAngle = start;
  let startTime = null;

  function animateSpin(timestamp) {
    if (!startTime) startTime = timestamp;
    const elapsed = timestamp - startTime;
    const progress = Math.min(elapsed / spinTimeTotal, 1);

    currentAngle = start + (finalAngle - start) * easeOut(progress);
    if (currentAngle - lastTickAngle >= tickInterval) {
      tickerSound.pause();
      tickerSound.currentTime = 0;
      tickerSound.play();
      lastTickAngle += tickInterval;
    }
    drawWheel();

    if (progress < 1) {
      requestAnimationFrame(animateSpin);
    } else {
      currentAngle = finalAngle;
      drawWheel();
      setTimeout(() => {
        isSpinning = false;
        setFrameState(null);
        settleAndReveal(spinId, wheelSpinner);
      }, 500);
    }
  }

  requestAnimationFrame(animateSpin);
}

function easeOut(t) {
  return 1 - Math.pow(1 - t, 3);
}

let spinId = 0;

// Fetch the Jackpot Total
function fetchJackpotTotal() {
  fetch(`/api/jackpot`)
      .then(response => response.json())
      .then(data => {
          if (data.jackpotTotal !== undefined) {
              // The wheel's jackpot is the casino pot capped (wheelJackpot); older servers lack it.
              const shown = (data.wheelJackpot !== undefined) ? data.wheelJackpot : data.jackpotTotal;
              document.getElementById('jackpotTotal').textContent = Number(shown).toLocaleString();
          } else {
              console.error('Failed to fetch balance:', data.error);
              document.getElementById('jackpotTotal').textContent = 'Error fetching balance';
          }
      })
      .catch(error => {
          console.error('Fetch error:', error);
          document.getElementById('jackpotTotal').textContent = 'Error fetching balance';
      });
}

fetchJackpotTotal()
loadWheelConfig();   // the public/OBS wheel: fixed level 20 on the server

// Auto-refresh jackpot every 5 seconds
setInterval(fetchJackpotTotal, 5000);

// The wheel landed — tell the server (spinId only). It credits the payout it decided at
// spin time and returns it; we just render the reveal. Nothing here is client-authoritative.
function settleAndReveal(spinId, spinner) {
  fetch(`/api/wheel/settle`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spinId: spinId }),
    method: "POST"
  })
  .then(response => response.json())
  .then(data => {
    console.log('Settle response:', data);
    if (data.grand) {
      setFrameState('jackpot');
      showJackpotRoll(100, Number(data.result) || 0, true, tickerSound);
      clearTimeout(resultTimer);
      resultTimer = setTimeout(hideResultOverlay, 45000);
    } else if (data.jackpot) {
      // Animate the server's % roll (needle over the roll's bands), then count up the win.
      setFrameState('jackpot');
      showJackpotRoll(data.jackpotPct || 0, Number(data.result) || 0, false, tickerSound);
      clearTimeout(resultTimer);
      resultTimer = setTimeout(hideResultOverlay, 45000);
    } else {
      drawResultOverlay(Number(data.result || 0), spinner);
    }
    fetchJackpotTotal();
  })
  .catch(error => {
    console.error('Error settling spin:', error);
  });
}

// Frame state drives the bulbs: 'spinning' (fast chase), 'won' (flash), 'jackpot' (gold race), null (idle).
function setFrameState(state) {
  if (!wheelFrame) return;
  wheelFrame.classList.remove('spinning', 'won', 'jackpot');
  if (state) wheelFrame.classList.add(state);
}

// "NOW SPINNING <name>" strip under the wheel; it stays up with the result.
function showSpinner(name, label) {
  const strip = document.getElementById('nowSpinning');
  const nameEl = document.getElementById('spinnerName');
  if (!strip || !nameEl) return;
  const k = strip.querySelector('.k');
  if (k) k.textContent = label || 'NOW SPINNING';
  nameEl.textContent = name || '';
  nameEl.style.cssText = name ? (window.spinnerCss || '') : '';      // the spinner's equipped name colour
  strip.classList.toggle('show', !!name);
}

// Neon winner banner over the wheel. Text only goes in via textContent.
var resultTimer = null;
function drawResultOverlay(amount, spinner) {
  const resultContainer = document.getElementById('resultContainer');
  const resultText = document.getElementById('resultText');
  const banner = resultContainer.querySelector('.ow-banner');
  const tag = document.getElementById('resultTag');
  const who = document.getElementById('resultWho');
  const won = Number(amount) || 0;

  if (banner) {
    banner.classList.toggle('zero', won <= 0);
    banner.style.animation = 'none'; void banner.offsetWidth; banner.style.animation = '';   // replay the pop
  }
  if (tag) tag.textContent = won > 0 ? 'WINNER' : 'NO PRIZE';
  if (who) { who.textContent = spinner || ''; who.style.cssText = spinner ? (window.spinnerCss || '') : ''; }
  resultText.textContent = won.toLocaleString();
  resultContainer.style.display = 'flex';
  setFrameState(won > 0 ? 'won' : null);
  if (spinner) showSpinner(spinner, 'LAST SPIN');

  clearTimeout(resultTimer);
  resultTimer = setTimeout(hideResultOverlay, 45000);
}

// Hides the result (banner or jackpot roll) and puts the wheel back to idle.
function hideResultOverlay() {
  if (typeof hideJackpotRoll === 'function') hideJackpotRoll();
  clearTimeout(resultTimer);
  document.getElementById('resultContainer').style.display = 'none';
  if (!isSpinning) { setFrameState(null); showSpinner(''); }
}

function acknowledgeSpin(spinId) {
  fetch(`/api/g/acknowledge-spin`, {
      method: 'POST',
      headers: {
          'Content-Type': 'application/json'
      },
      body: JSON.stringify({ spinId: spinId })
  })
  .then(response => response.json())
  .then(data => {
      console.log('Acknowledgment response:', data);
      if (data.success) {
          console.log("Spin command received:", data);
          const parts = data.message.split(' '); // "public spinid <spinId> from <username>"
          // the PATV display name (the username in the message is e.g. "CFxxxxxxxx" for Pepe's accounts)
          const spinnerName = (data.spinner && data.spinner.display) || parts[4];
          window.spinnerCss = (data.spinner && data.spinner.nameCss) || '';
          const sId = parts[2];
          // targetIndex is the server-chosen winning slice — the wheel animates to it.
          spinWheel(spinnerName, sId, data.targetIndex);
      } else {
          alert('Failed to acknowledge spin:', data.message);
      }
  })
  .catch(error => {
      console.error('Error sending acknowledgment:', error);
  });
}


// Function for initiating the user spin from the backend.
function setupSpinListener(username) {
  const eventSource = new EventSource(`/events?type=spin&identifier=public`);
  console.log(eventSource);
  // Connected: forget earlier failures, so drops spread over days never add up to a reload.
  eventSource.onopen = function() { reconnectAttempts = 0; };
  eventSource.onmessage = function(event) {
      const data = JSON.parse(event.data);
      console.log(data);
      if (data.message.includes("Request") && data.spinId) {
          console.log("Spin request received:", data);
          acknowledgeSpin(data.spinId);
      }
  };

  eventSource.onerror = function(event) {
    console.error('EventSource failed:', event);
    checkConnection(eventSource);
};
}


// Function for reconnecting to Event Source
var reconnectAttempts = 0;

// The browser retries a dropped stream by itself (readyState CONNECTING); it only gives up -
// CLOSED - when a retry gets a non-stream answer, e.g. the error page while the site restarts.
// Then we reconnect ourselves, but ONLY once /healthz says the site is back: reloading (or
// reconnecting) into a restart left OBS showing an error page with no script in it - a dead
// wheel until someone refreshed the source by hand.
function checkConnection(es) {
  if (es.readyState !== EventSource.CLOSED) return;
  reconnectAttempts++;
  const delay = Math.min(60000, 5000 * reconnectAttempts);
  console.log(`Connection closed - retrying in ${delay / 1000}s (attempt ${reconnectAttempts})`);
  setTimeout(async function() {
    try {
      const r = await fetch('/healthz', { cache: 'no-store' });
      if (r.ok) {
        if (reconnectAttempts > 5) {
          window.location.reload();          // a fresh page, now that the site is up
        } else {
          setupSpinListener('public');
        }
        return;
      }
    } catch (e) { /* still down */ }
    checkConnection(es);                     // site still down: wait longer and check again
  }, delay);
}


setupSpinListener('public');

drawWheel();