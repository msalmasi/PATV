const canvas = document.getElementById('wheelCanvas');
const ctx = canvas.getContext('2d');
const spinButton = document.getElementById('spinButton');

// Arrow element
const arrow = document.createElement('div');
arrow.id = 'arrow';
document.querySelector('.wheel-container').appendChild(arrow);

// Center image
const centerImage = document.createElement('img');
centerImage.id = 'centerImage';
document.querySelector('.wheel-container').appendChild(centerImage);

// Set your custom image or GIF URL
centerImage.src = 'giphy.gif';

const wheelRadius = canvas.width / 2;
const centerX = canvas.width / 2;
const centerY = canvas.height / 2;

const segments = [
  { color: '#FF6347', label: '100 points', size: 1 },
  { color: '#FFD700', label: '200 points', size: 1 },
  { color: '#ADFF2F', label: '300 points', size: 1 },
  { color: '#00FA9A', label: '500 points', size: 1 },
  { color: '#1E90FF', label: 'No win', size: 1 },
  { color: '#EE82EE', label: '1000 points', size: 1 },
  { color: '#FF69B4', label: '50 points', size: 1 },
  { color: '#20B2AA', label: '400 points', size: 1 },
  { color: '#FFA500', label: '150 points', size: 1 },
  { color: '#B22222', label: '250 points', size: 1 },
  { color: '#8A2BE2', label: '350 points', size: 1 },
  { color: '#5F9EA0', label: '450 points', size: 1 },
  { color: '#FF4500', label: '1500 points', size: 1 },
  { color: '#DA70D6', label: '75 points', size: 1 },
  { color: '#DB7093', label: '125 points', size: 1 },
  { color: '#3CB371', label: '175 points', size: 1 },
  { color: '#4682B4', label: '225 points', size: 1 },
  { color: '#FF1493', label: '275 points', size: 1 },
  { color: '#00CED1', label: '3500 points', size: 1 },
  { color: '#FFD700', label: 'JACKPOT', size: 0.2 }  // Very thin jackpot slice
];

let currentAngle = 0;
let isSpinning = false;

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

function spinWheel() {
  if (isSpinning) return;
  isSpinning = true;

  const spinTimeTotal = 5000 + Math.random() * 5000; // Randomized spin time between 5-10 seconds
  const spinAngleStart = Math.random() * 5000 + 5000; // Randomized initial spin velocity

  let startTime = null;

  function animateSpin(timestamp) {
    if (!startTime) startTime = timestamp;
    const elapsed = timestamp - startTime;
    const progress = Math.min(elapsed / spinTimeTotal, 1);

    const spinAngle = spinAngleStart * (1 - easeOut(progress)) * (Math.PI / 180);
    currentAngle = (currentAngle + spinAngle) % (2 * Math.PI);
    console.log(currentAngle);
    drawWheel();

    if (progress < 1) {
      requestAnimationFrame(animateSpin);
    } else {
      setTimeout(() => { // Allow the wheel to visually stop before showing the result
        isSpinning = false;
        determineSpinResult();
      }, 500); 
    }
  }

  requestAnimationFrame(animateSpin);
}

function easeOut(t) {
  return 1 - Math.pow(1 - t, 3);
}

function determineSpinResult() {
  const totalSize = segments.reduce((acc, seg) => acc + seg.size, 0);
  const segmentAngle = (2 * Math.PI) / totalSize;

  // Adjust current angle so that 0 degrees aligns with the arrow (top position)
  let angle = (2 * Math.PI - (currentAngle % (2 * Math.PI))) % (2 * Math.PI) - ((2 * Math.PI) / 4);
  let cumulativeAngle = 0;

  for (let i = 0; i < segments.length; i++) {
    cumulativeAngle += (segments[i].size / totalSize) * 2 * Math.PI;
    if (angle <= cumulativeAngle) {
        console.log(angle);
        console.log(cumulativeAngle);
      const result = segments[i].label;
      console.log(segments[i]);
      console.log(i);
      alert(`You won: ${result}`);
      break;
    }
  }

  // Send result to backend here
}

spinButton.addEventListener('click', spinWheel);

drawWheel();