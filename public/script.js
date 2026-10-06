// Gold wheel (views/wheel.ejs). The SERVER picks the prize; this page only renders the wheel,
// asks for a spin, and animates to the slice the server chose. The coin-slot interaction that
// triggers userSpin() lives in /public/js/coinop.js.
const canvas = document.getElementById('wheelCanvas');
const ctx = canvas.getContext('2d');
const spinButton = document.getElementById('spinButton');
const reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

// Spin ticker (absolute path - the page lives at /u/<name>/wheel). Honours the page's mute toggle.
const tickerSound = new Audio('/public/wheel.ogg');
function playTick() {
  if (window.wheelMuted) return;
  try { tickerSound.pause(); tickerSound.currentTime = 0; const p = tickerSound.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}
// jackpotroll.js calls tick.pause()/currentTime/play() - hand it a mute-aware stand-in.
const tickProxy = { pause() {}, set currentTime(v) {}, play() { playTick(); } };

// Generate a unique ID for this page/session
const pageId = Math.random().toString(36).substring(2, 15);

// Arrow element
const arrow = document.createElement('div');
arrow.id = 'arrow';
document.querySelector('.wheel-container').appendChild(arrow);

// Center image
const centerImage = document.createElement('img');
centerImage.id = 'centerImage';
centerImage.alt = '';
document.querySelector('.wheel-container').appendChild(centerImage);
centerImage.src = '/public/img/star.gif';

const wheelRadius = canvas.width / 2;
const centerX = canvas.width / 2;
const centerY = canvas.height / 2;

var username = getUsernameFromUrl();
window.wheelBalance = null;   // last known balance (number) - coinop.js uses it for the bounce check

// Fetch user balance and username first
fetchUsername(username);
fetchUserBalance(username);

// Fetch user level, then define segments and draw wheel
fetchUserLevel(username).then(userLevel => {
  // 1% per 2 levels, capped at 20 - same as the server (the server's table replaces this below).
  const multiplier = 1 + Math.floor((Math.min(Math.max(userLevel, 1), 20) - 1) / 2) * 0.01;
  segments = segments.map(s => s.jackpot ? s : Object.assign({}, s, { label: String(Math.round(Number(s.label) * multiplier)) }));
  drawWheel();
  renderPrizeTable();
  loadWheelConfig(userLevel);   // the server's level-scaled table
  adjustWheelBorder(userLevel);
});

// Function to adjust wheel border based on level
function adjustWheelBorder(userLevel) {
  let borderColor;
  if (userLevel < 10) borderColor = '#FFFFFF';        // White for levels 1-9
  else if (userLevel < 20) borderColor = '#C0C0C0';   // Silver for levels 10-19
  else borderColor = '#F2AE2E';                       // Gold for level 20 and above
  canvas.style.borderColor = borderColor;
  arrow.style.borderTopColor = borderColor;
}

// Built-in fallback table (base values); /api/wheel/config is authoritative.
let segments = [
  { color: '#FF6347', label: '2700', size: 1 },
  { color: '#FFD700', label: '5350', size: 1 },
  { color: '#ADFF2F', label: '3650', size: 1 },
  { color: '#00FA9A', label: '7750', size: 0.9 },
  { color: '#1E90FF', label: '700', size: 1 },
  { color: '#EE82EE', label: '0', size: 1 },
  { color: '#FF69B4', label: '22500', size: 0.5 },
  { color: '#20B2AA', label: '920', size: 1 },
  { color: '#FFA500', label: '5950', size: 1 },
  { color: '#B22222', label: '4550', size: 1 },
  { color: '#8A2BE2', label: '4100', size: 1 },
  { color: '#5F9EA0', label: '1400', size: 1 },
  { color: '#EE82EE', label: '0', size: 1 },
  { color: '#FFD700', label: '46000', size: 0.1 },
  { color: '#DB7093', label: '2250', size: 1 },
  { color: '#3CB371', label: '430', size: 1 },
  { color: '#4682B4', label: '1850', size: 1 },
  { color: '#FF1493', label: '11500', size: 0.8 },
  { color: '#00CED1', label: '0', size: 1 },
  { color: '#FFD700', label: '6900', size: 1 },
  { color: '#3CB371', label: '4950', size: 1 },
  { color: '#4682B4', label: '3250', size: 1 },
  { color: '#FF1493', label: '8200', size: 1 },
  { color: '#8A2BE2', label: '9200', size: 1 },
  { color: '#00CED1', label: '0', size: 1 },
  { color: '#FFD700', label: '🏆 JACKPOT 🏆', size: 0.00777, jackpot: true }
];

let currentAngle = 0 - ((2 * Math.PI) / 4);
let isSpinning = false;

// Draws the Wheel
function drawWheel() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

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
      const pulse = reduceMotion ? 1 : 0.5 + 0.5 * Math.sin(Date.now() / 250);
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
if (!reduceMotion) setInterval(() => { if (!isSpinning && segments.length && !document.hidden) drawWheel(); }, 60);

// The server owns the slice table (/api/wheel/config) - the arrays here are only a fallback.
function loadWheelConfig(level) {
  const q = (level !== undefined && level !== null) ? ('?level=' + encodeURIComponent(level)) : '';
  return fetch('/api/wheel/config' + q)
    .then(r => r.json())
    .then(cfg => {
      if (cfg && Array.isArray(cfg.segments) && cfg.segments.length && !isSpinning) {
        segments = cfg.segments;
        drawWheel();
        renderPrizeTable();
      }
    })
    .catch(err => console.error('wheel config fetch failed, using the built-in table:', err));
}

// Prize table: distinct prizes, best first, with odds from the slice sizes.
function renderPrizeTable() {
  const body = document.getElementById('prizeTable');
  if (!body) return;
  const total = segments.reduce((a, s) => a + s.size, 0);
  const groups = new Map();
  segments.forEach(s => {
    const key = s.jackpot ? 'JACKPOT' : String(Number(s.label) || 0);
    const g = groups.get(key) || { value: s.jackpot ? Infinity : (Number(s.label) || 0), size: 0, color: s.color, jackpot: !!s.jackpot };
    g.size += s.size;
    groups.set(key, g);
  });
  const rows = Array.from(groups.values()).sort((a, b) => b.value - a.value);
  body.textContent = '';
  rows.forEach(g => {
    const tr = document.createElement('tr');
    if (g.jackpot) tr.className = 'jp';
    else if (!g.value) tr.className = 'zero';
    const td1 = document.createElement('td');
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = g.color;
    td1.appendChild(sw);
    td1.appendChild(document.createTextNode(g.jackpot ? 'JACKPOT ROLL (2-100% of pot)' : (g.value ? g.value.toLocaleString() : 'Nothing')));
    const td2 = document.createElement('td');
    td2.className = 'num';
    const n = total / g.size;
    td2.textContent = n >= 1.95 ? '1 in ' + Math.round(n).toLocaleString() : Math.round(100 / n) + '%';
    tr.appendChild(td1);
    tr.appendChild(td2);
    body.appendChild(tr);
  });
}

// Wheel Animation Function
// The SERVER already decided which slice wins (targetIndex); we animate the wheel to land
// there. The spin reveals the result, it no longer determines it (anti-forgery refactor).
function spinWheel(targetIndex) {
  hideResultOverlay();
  if (isSpinning) return;
  if (typeof targetIndex !== 'number' || targetIndex < 0 || targetIndex >= segments.length) {
    console.error("No/invalid targetIndex from server; aborting spin.", targetIndex);
    return;
  }
  isSpinning = true;
  document.dispatchEvent(new CustomEvent('wheel:spinstart'));

  const twoPi = 2 * Math.PI;
  const totalSize = segments.reduce((acc, seg) => acc + seg.size, 0);
  let cumBefore = 0;
  for (let i = 0; i < targetIndex; i++) cumBefore += (segments[i].size / totalSize) * twoPi;
  const sliceFrac = (segments[targetIndex].size / totalSize) * twoPi;
  const A = cumBefore + sliceFrac / 2;
  const targetMod = (((3 * Math.PI / 2 - A) % twoPi) + twoPi) % twoPi;

  const start = currentAngle;
  const startMod = ((start % twoPi) + twoPi) % twoPi;
  const delta = (((targetMod - startMod) % twoPi) + twoPi) % twoPi;
  const extraTurns = reduceMotion ? 1 : 5;
  const finalAngle = start + extraTurns * twoPi + delta;

  const spinTimeTotal = reduceMotion ? 1800 : 6000;
  const tickInterval = 2 * twoPi / segments.length;
  let lastTickAngle = start;
  let startTime = null;

  function animateSpin(timestamp) {
    if (!startTime) startTime = timestamp;
    const elapsed = timestamp - startTime;
    const progress = Math.min(elapsed / spinTimeTotal, 1);

    currentAngle = start + (finalAngle - start) * easeOut(progress);
    if (currentAngle - lastTickAngle >= tickInterval) {
      playTick();
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
        settleAndReveal();
      }, 500);
    }
  }

  requestAnimationFrame(animateSpin);
}

function easeOut(t) {
  return 1 - Math.pow(1 - t, 3);
}

let spinId = 0;

// Get Username from URL (/u/<username>/wheel)
function getUsernameFromUrl() {
  return window.location.pathname.split('/')[2];
}

function fetchUsername(name) {
  const el = document.getElementById('usernameSpan');
  if (el && !el.textContent.trim()) el.textContent = decodeURIComponent(name || '');
}

// Fetch and Set the User Balance
function fetchUserBalance(name) {
  const el = document.getElementById('userBalance');
  return fetch(`/api/u/${name}/balance`)
    .then(response => response.json())
    .then(data => {
      if (data.balance !== undefined) {
        window.wheelBalance = Number(data.balance);
        el.textContent = Number(data.balance).toLocaleString();
      } else {
        console.error('Failed to fetch balance:', data.error);
        el.textContent = 'Error';
      }
    })
    .catch(error => {
      console.error('Fetch error:', error);
      el.textContent = 'Error';
    });
}

// Calculate XP for next level
function xpForNextLevel(currentLevel) {
  return Math.pow(currentLevel + 1, 2) * 1000;
}

// Update the level bar and return the user's level
function fetchUserLevel(name) {
  return fetch(`/api/u/${name}/level`)
    .then(response => response.json())
    .then(data => {
      if (data.level !== undefined) {
        const xp = Math.round(data.xp);
        const level = data.level;
        const xpNeeded = xpForNextLevel(level);
        const progressPercentage = Math.min(100, (xp / xpNeeded) * 100);
        const progressBar = document.querySelector('.level-progress');
        if (progressBar) progressBar.style.width = `${progressPercentage}%`;
        document.getElementById('userXP').textContent = `${xp.toLocaleString()} / ${xpNeeded.toLocaleString()} XP`;
        document.getElementById('userLevel').textContent = `Level ${level}`;
        return level;
      }
      console.error('Failed to fetch user level:', data.error);
      return 1; // Default to level 1 in case of error
    })
    .catch(error => {
      console.error('Fetch error:', error);
      return 1;
    });
}

// Fetch the Jackpot Total
function fetchJackpotTotal() {
  const el = document.getElementById('jackpotTotal');
  fetch(`/api/jackpot`)
    .then(response => response.json())
    .then(data => {
      if (data.jackpotTotal !== undefined) {
        // The wheel's jackpot is the casino pot capped (wheelJackpot); older servers lack it.
        const shown = (data.wheelJackpot !== undefined) ? data.wheelJackpot : data.jackpotTotal;
        el.textContent = Number(shown).toLocaleString();
      } else {
        el.textContent = '?';
      }
    })
    .catch(error => {
      console.error('Fetch error:', error);
      el.textContent = '?';
    });
}

fetchJackpotTotal();
setInterval(() => { if (!document.hidden) fetchJackpotTotal(); }, 30000);

// Status line (role=status, so screen readers hear it). kind: '', 'err', 'ok', 'win'.
function setSpinStatus(msg, kind, html) {
  const ss = document.getElementById('spinStatus');
  if (!ss) return;
  ss.className = 'aw-status' + (kind ? ' ' + kind : '');
  if (html) ss.innerHTML = msg; else ss.textContent = msg;
}
window.setSpinStatus = setSpinStatus;

// Ask the server for a spin. Resolves { ok: true, spinId } or { ok: false, message, login }.
// (The server then pushes a "spin" event over SSE; acknowledgeSpin() charges it and we animate.)
function userSpin() {
  const name = getUsernameFromUrl();
  return fetch(`/api/u/${name}/wheel/spin`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: name, pageId: pageId }),
    method: "POST",
    credentials: 'same-origin',
  })
    .then(async response => {
      const type = response.headers.get('content-type') || '';
      // An expired login redirects to the /login HTML page.
      if (response.redirected || /\/login/.test(response.url) || response.status === 401) {
        return { ok: false, login: true, message: 'Your session expired. Sign in again to play.' };
      }
      if (!response.ok) {
        const msg = await response.text().catch(() => '');
        return { ok: false, message: (msg && msg.length < 240) ? msg : 'Spin already in progress.' };
      }
      if (type.indexOf('json') === -1) return { ok: false, message: 'Unexpected reply from the server. Refresh and try again.' };
      const data = await response.json();
      if (data.spinId === undefined) return { ok: false, message: 'Spin already in progress.' };
      spinId = data.spinId;
      fetchJackpotTotal();
      if (typeof updateSpinsLeft === 'function') updateSpinsLeft();
      return { ok: true, spinId: data.spinId };
    })
    .catch(error => {
      console.error('Error making the POST request:', error);
      return { ok: false, message: 'Network error. Check your connection and try again.' };
    });
}
window.userSpin = userSpin;

// The wheel landed - tell the server (spinId only). It credits the payout it decided at
// spin time and returns it; we just render the reveal. Nothing here is client-authoritative.
function settleAndReveal() {
  const name = getUsernameFromUrl();
  fetch(`/api/wheel/settle`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spinId: spinId }),
    method: "POST"
  })
    .then(response => response.json())
    .then(data => {
      fetchUserBalance(name);
      fetchUserLevel(name);
      fetchJackpotTotal();
      const won = Number(data.result) || 0;
      if (data.grand) {
        showJackpotRoll(100, won, true, tickProxy);
        setTimeout(hideJackpotRoll, 45000);
      } else if (data.jackpot) {
        // Animate the server's % roll (needle over the roll's bands), then count up the win.
        showJackpotRoll(data.jackpotPct || 0, won, false, tickProxy);
        setTimeout(hideJackpotRoll, 45000);
      } else if (data.result !== undefined) {
        drawResultOverlay(won.toLocaleString());
      }
      if (data.result !== undefined) {
        displayPointsReward(won.toLocaleString());
        displayXPReward(data.xp || 0);
        if (data.levelUp && data.levelUp.leveledUp) {
          displayLevelUpAnimation(data.levelUp.levelsGained, data.levelUp.newLevel, data.levelUp.bonusPoints, data.levelUp.milestones);
        }
        const what = data.grand ? 'GRAND JACKPOT! ' : (data.jackpot ? 'JACKPOT (' + (data.jackpotPct || 0) + '% of the pot)! ' : '');
        const c = data.cosmetic;   // a rare cosmetic drop (rolled server-side)
        const found = c && c.name ? ' 🎁 You found a cosmetic: ' + c.name + (c.rarity ? ' (' + String(c.rarity).toUpperCase() + ')' : '') + '! Wear it from Cosmetics → My items.' : '';
        if (won > 0) setSpinStatus(what + 'You won ' + won.toLocaleString() + ' PAT.' + found, 'win');
        else setSpinStatus(found ? 'No PAT this time.' + found : 'No prize this time. Press the coin to play again.', found ? 'win' : '');
      } else {
        setSpinStatus((data && data.error) ? 'Could not settle the spin: ' + data.error : 'Could not settle the spin. Refresh the page.', 'err');
      }
      document.dispatchEvent(new CustomEvent('wheel:result', { detail: data || {} }));
    })
    .catch(error => {
      console.error('Error settling spin:', error);
      setSpinStatus('Could not settle the spin. Refresh the page.', 'err');
      document.dispatchEvent(new CustomEvent('wheel:result', { detail: { error: true } }));
    });
}

// Function to display level-up animation
function displayLevelUpAnimation(levelsGained, newLevel, bonusPoints, milestones) {
  const animationContainer = document.createElement('div');
  animationContainer.className = 'arcade-animation-container';
  animationContainer.id = 'animationContainer';
  animationContainer.setAttribute('role', 'alert');

  const levelUpDiv = document.createElement('div');
  levelUpDiv.className = 'arcade-animation-level-up';
  levelUpDiv.textContent = `Level Up (+${levelsGained})! You reached Level ${newLevel}!`;

  const bonusPointsDiv = document.createElement('div');
  bonusPointsDiv.className = 'arcade-animation-bonus-points';
  const ms = Array.isArray(milestones) && milestones.length ? milestones[milestones.length - 1] : 0;
  bonusPointsDiv.textContent = (bonusPoints > 0 ? `You received ${Number(bonusPoints).toLocaleString()} PAT!` : '') +
    (ms ? ` Level ${ms} milestone: new cosmetic unlocked!` : '');

  const frogDanceImg = document.createElement('img');
  frogDanceImg.className = 'arcade-animation-frog-dance';
  frogDanceImg.src = `/public/img/dancefrog.gif`;
  frogDanceImg.alt = 'Dancing Frog';

  animationContainer.appendChild(levelUpDiv);
  animationContainer.appendChild(bonusPointsDiv);
  animationContainer.appendChild(frogDanceImg);
  document.body.appendChild(animationContainer);

  setTimeout(() => { animationContainer.remove(); }, 5000);
}

// Displays the winning result over the wheel.
let resultTimer = null;
function drawResultOverlay(result) {
  const resultContainer = document.getElementById('resultContainer');
  const resultText = document.getElementById('resultText');
  resultContainer.style.display = 'flex';
  resultContainer.style.backgroundColor = 'rgba(0, 0, 0, 0.65)';
  resultText.textContent = result;
  clearTimeout(resultTimer);
  resultTimer = setTimeout(hideResultOverlay, 45000);
}

// Hides the winning result over the wheel.
function hideResultOverlay() {
  if (typeof hideJackpotRoll === 'function') hideJackpotRoll();
  document.getElementById('resultContainer').style.display = 'none';
}

// Little floating "+PAT" / "-PAT" / "+XP" pops next to the stat they change.
function popNear(el, cls, text, id) {
  if (!el) return;
  const d = document.createElement('div');
  d.className = cls;
  if (id) d.id = id;
  d.setAttribute('aria-hidden', 'true');
  d.textContent = text;
  el.parentNode.insertBefore(d, el.nextSibling);
  setTimeout(() => d.remove(), 2500);
}
function displayPointsReward(result) {
  popNear(document.getElementById('userBalance'), 'arcade-animation', `+${result}`, 'rewardDiv');
}
function displayWagerCost(wager) {
  const rewardDiv = document.getElementById('rewardDiv');
  if (rewardDiv) rewardDiv.remove();
  popNear(document.getElementById('userBalance'), 'arcade-animation-neg', `-${Number(wager).toLocaleString()}`);
}
function displayXPReward(xp) {
  popNear(document.getElementById('userXP'), 'arcade-animation-xp', `+${Math.round(xp)} XP`, 'xpDiv');
}

// Server -> page: the spin request arrives over SSE; acknowledge it, then animate.
let eventSource = null;
function setupSpinListener() {
  eventSource = new EventSource(`/events?type=spin&identifier=${pageId}`);
  eventSource.onmessage = function (event) {
    let data;
    try { data = JSON.parse(event.data); } catch (e) { return; }
    if (data && data.message && data.message.includes("Request") && data.spinId) {
      acknowledgeSpin(data.spinId);
    }
  };
  eventSource.onerror = function (event) {
    console.error('EventSource failed:', event);
    checkConnection(eventSource);
  };
}

function acknowledgeSpin(ackSpinId) {
  fetch(`/api/u/acknowledge-spin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spinId: ackSpinId })
  })
    .then(response => response.json())
    .then(data => {
      if (data.success) {
        spinId = ackSpinId;            // set the global spinId used by settleAndReveal
        displayWagerCost(5000);
        fetchUserBalance(username);
        // Let the coin-slot animation finish (CREDIT 01) before the wheel starts.
        Promise.resolve(window.wheelCoinGate).then(() => {
          setSpinStatus('Spinning…', '');
          spinWheel(data.targetIndex);   // animate to the server-chosen slice
        });
      } else {
        setSpinStatus('Spin failed: ' + (data.message || 'please refresh and try again.'), 'err');
        document.dispatchEvent(new CustomEvent('wheel:result', { detail: { error: true } }));
      }
    })
    .catch(error => {
      console.error('Error sending acknowledgment:', error);
      setSpinStatus('Spin failed. Refresh the page and try again.', 'err');
      document.dispatchEvent(new CustomEvent('wheel:result', { detail: { error: true } }));
    });
}

// Reconnect the event stream; after 5 failed attempts, reload the page.
var reconnectAttempts = 0;
function checkConnection(es) {
  if (es.readyState !== EventSource.CLOSED) return;   // the browser is retrying on its own
  reconnectAttempts++;
  if (reconnectAttempts > 5) {
    window.location.reload();
  } else {
    setTimeout(setupSpinListener, 5000);
  }
}

setupSpinListener();
