const canvas = document.getElementById('wheelCanvas');
const ctx = canvas.getContext('2d');

// Load the audio file at the start of the script
const tickerSound = new Audio('/public/wheel.ogg');

// Arrow element
const arrow = document.createElement('div');
arrow.id = 'arrow';
document.querySelector('.wheel-container').appendChild(arrow);

// Center image
const centerImage = document.createElement('img');
centerImage.id = 'centerImage';
document.querySelector('.wheel-container').appendChild(centerImage);

// Set your custom image or GIF URL
centerImage.src = '/public/img/star.gif';

const wheelRadius = canvas.width / 2;
const centerX = canvas.width / 2;
const centerY = canvas.height / 2;

const multiplier = 1 + (20 * 0.01);

// Set the Wheel Prizes
const segments = [
  { color: '#FF6347', label: Math.round(3000 * multiplier), size: 1 },
  { color: '#FFD700', label: Math.round(6000 * multiplier), size: 1 },
  { color: '#ADFF2F', label: Math.round(4000 * multiplier), size: 1 },
  { color: '#00FA9A', label: Math.round(8500 * multiplier), size: 0.9 },
  { color: '#1E90FF', label: Math.round(750 * multiplier), size: 1 },
  { color: '#EE82EE', label: Math.round(0 * multiplier), size: 1 },
  { color: '#FF69B4', label: Math.round(25000 * multiplier), size: 0.5 },
  { color: '#20B2AA', label: Math.round(1000 * multiplier), size: 1 },
  { color: '#FFA500', label: Math.round(6500 * multiplier), size: 1 },
  { color: '#B22222', label: Math.round(5000 * multiplier), size: 1 },
  { color: '#8A2BE2', label: Math.round(4500 * multiplier), size: 1 },
  { color: '#5F9EA0', label: Math.round(1500 * multiplier), size: 1 },
  { color: '#EE82EE', label: Math.round(0 * multiplier), size: 1 },
  { color: '#FFD700', label: Math.round(50000 * multiplier), size: 0.1 },
  { color: '#DB7093', label: Math.round(2500 * multiplier), size: 1 },
  { color: '#3CB371', label: Math.round(500 * multiplier), size: 1 },
  { color: '#4682B4', label: Math.round(2000 * multiplier), size: 1 },
  { color: '#FF1493', label: Math.round(12500 * multiplier), size: 0.8 },
  { color: '#00CED1', label: Math.round(0 * multiplier), size: 1 },
  { color: '#FFD700', label: Math.round(7500 * multiplier), size: 1 },
  { color: '#3CB371', label: Math.round(5500 * multiplier), size: 1 },
  { color: '#4682B4', label: Math.round(3500 * multiplier), size: 1 },
  { color: '#FF1493', label: Math.round(9000 * multiplier), size: 1 },
  { color: '#8A2BE2', label: Math.round(10000 * multiplier), size: 1 },
  { color: '#00CED1', label: Math.round(0 * multiplier), size: 1 },
  { color: '#FFD700', label: '🏆🏆🏆JACKPOT🏆🏆🏆', size: 0.05 }
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

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate((angleStart + angleEnd) / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fff';
    ctx.font = '16px Arial';
    ctx.fillText(segment.label, wheelRadius - 10, 10);
    ctx.restore();

    angleStart = angleEnd;
  });

  // No center circle, center image replaces it
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
        settleAndReveal(spinId);
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
              document.getElementById('jackpotTotal').textContent = data.jackpotTotal;
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

// Auto-refresh jackpot every 5 seconds
setInterval(fetchJackpotTotal, 5000);

// The wheel landed — tell the server (spinId only). It credits the payout it decided at
// spin time and returns it; we just render the reveal. Nothing here is client-authoritative.
function settleAndReveal(spinId) {
  fetch(`/api/wheel/settle`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spinId: spinId }),
    method: "POST"
  })
  .then(response => response.json())
  .then(data => {
    console.log('Settle response:', data);
    if (data.grand) {
      drawResultOverlay("🏆🏆🏆 GRAND JACKPOT! The WHOLE pot: " + Number(data.result).toLocaleString() + " 🏆🏆🏆");
    } else if (data.jackpot) {
      drawResultOverlay("🏆 JACKPOT! You won " + (data.jackpotPct || 0) + "% of the pot: " + Number(data.result).toLocaleString() + " 🏆");
    } else {
      drawResultOverlay(Number(data.result || 0).toLocaleString());
    }
    fetchJackpotTotal();
  })
  .catch(error => {
    console.error('Error settling spin:', error);
  });
}

// Displays the winning result over the wheel.
function drawResultOverlay(result) {
  const resultContainer = document.getElementById('resultContainer');
  const resultText = document.getElementById('resultText');

  resultContainer.style.display = 'flex'; // Show the container
  resultContainer.style.backgroundColor = 'rgba(0, 0, 0, 0.65)'; // Semi-transparent background

  resultText.textContent = result; // Set the result text
  setTimeout(function(){
    hideResultOverlay();
  }, 45000);
}

// Hides the winning result over the wheel.
function hideResultOverlay() {
  const resultContainer = document.getElementById('resultContainer');
  const resultText = document.getElementById('resultText');

  resultContainer.style.display = 'none'; // Show the container
  resultContainer.style.backgroundColor = 'rgba(0, 0, 0, 0.65)'; // Semi-transparent background
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
          const spinnerName = parts[4];
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

function checkConnection(es) {
  if (es.readyState === EventSource.CLOSED) {
      reconnectAttempts++;

      if (reconnectAttempts > 5) { // After 5 failed attempts, refresh the page
          console.log('Reconnecting failed multiple times, refreshing the page...');
          window.location.reload();
      } else {
          console.log('Connection was closed, attempting to reconnect...');
          setTimeout(function() {
            setupSpinListener('public');
          }, 5000);
      }
  }
}


setupSpinListener('public');

drawWheel();