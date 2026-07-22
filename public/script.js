const canvas = document.getElementById('wheelCanvas');
const ctx = canvas.getContext('2d');
const spinButton = document.getElementById('spinButton');

// Load the audio file at the start of the script
const tickerSound = new Audio('public/wheel.ogg');

// Generate a unique ID for this page/session
const pageId = Math.random().toString(36).substring(2, 15);

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

// Assuming username is available via some means (e.g., login session)
username = getUsernameFromUrl();
console.log(username);

// Fetch user balance and username first
fetchUsername(username);
fetchUserBalance(username);

// Fetch user level, then define segments and draw wheel
fetchUserLevel(username).then(userLevel => {
  console.log('User level:', userLevel);

  // Calculate the multiplier based on the user's level (1% per level)
  const multiplier = 1 + (userLevel * 0.01) - 0.01;
  console.log('Multiplier:', multiplier);

  // Define the wheel segments, scaling by user level
  segments = [
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

  // Update the wheel display with these values (implement your rendering logic here)
  drawWheel();

  // Change wheel border based on user level
  adjustWheelBorder(userLevel);
});

// Function to adjust wheel border based on level
function adjustWheelBorder(userLevel) {
  const wheelElement = document.getElementById('wheelCanvas');
  const arrow = document.getElementById('arrow');
  let borderColor;

  if (userLevel < 10) {
    borderColor = '#FFFFFF'; // White for levels 1-9
  } else if (userLevel >= 10 && userLevel < 20) {
    borderColor = '#C0C0C0'; // Silver for levels 10-19
  } else {
    borderColor = '#F2AE2E'; // Gold for level 20 and above
  }

  // Apply border color
  wheelElement.style.borderColor = borderColor;
  arrow.style.borderTopColor = borderColor;
}

// Set the Wheel Prizes
let segments = [
  { color: '#FF6347', label: '3000', size: 1 },
  { color: '#FFD700', label: '6000', size: 1 },
  { color: '#ADFF2F', label: '4000', size: 1 },
  { color: '#00FA9A', label: '8500', size: 0.9 },
  { color: '#1E90FF', label: '750', size: 1 },
  { color: '#EE82EE', label: '0', size: 1 },
  { color: '#FF69B4', label: '25000', size: 0.5 },
  { color: '#20B2AA', label: '1000', size: 1 },
  { color: '#FFA500', label: '6500', size: 1 },
  { color: '#B22222', label: '5000', size: 1 },
  { color: '#8A2BE2', label: '4500', size: 1 },
  { color: '#5F9EA0', label: '1500', size: 1 },
  { color: '#EE82EE', label: '0', size: 1 },
  { color: '#FFD700', label: '50000', size: .1 },
  { color: '#DB7093', label: '2500', size: 1 },
  { color: '#3CB371', label: '500', size: 1 },
  { color: '#4682B4', label: '2000', size: 1 },
  { color: '#FF1493', label: '12500', size: .8 },
  { color: '#00CED1', label: '0', size: 1 },
  { color: '#FFD700', label: '7500', size: 1 },
  { color: '#3CB371', label: '5500', size: 1 },
  { color: '#4682B4', label: '3500', size: 1 },
  { color: '#FF1493', label: '9000', size: 1 },
  { color: '#8A2BE2', label: '10000', size: 1 },
  { color: '#00CED1', label: '0', size: 1 },
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
  const extraTurns = 5;
  const finalAngle = start + extraTurns * twoPi + delta;

  const spinTimeTotal = 6000;
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

// Get Username from URL
function getUsernameFromUrl() {
  const pathname = window.location.pathname; // e.g., /u/coolusername/wheel
  const segments = pathname.split('/'); // Split the path by '/'
  // Assuming the structure /u/username/wheel, username would be at index 2
  return segments[2]; // This gets the username part of the URL
}

// Set the Username
function fetchUsername(username) {
  document.getElementById('usernameSpan').textContent = username;
}

// Fetch and Set the User Balance
function fetchUserBalance(username) {
  fetch(`/api/u/${username}/balance`)
      .then(response => response.json())
      .then(data => {
          if (data.balance !== undefined) {
              document.getElementById('userBalance').textContent = data.balance;
          } else {
              console.error('Failed to fetch balance:', data.error);
              document.getElementById('userBalance').textContent = 'Error fetching balance';
          }
      })
      .catch(error => {
          console.error('Fetch error:', error);
          document.getElementById('userBalance').textContent = 'Error fetching balance';
      });
}

// Calculate XP for next level
function xpForNextLevel(currentLevel) {
  return Math.pow(currentLevel + 1, 2) * 1000;
}

// Update the level bar and return the user's level
function fetchUserLevel(username) {
  return fetch(`/api/u/${username}/level`)
      .then(response => response.json())
      .then(data => {
          if (data.level !== undefined) {
            // Logging for debugging
            console.log("User level fetched successfully:", data.level);

            // Set the XP and level values
            const xp = Math.round(data.xp);
            const level = data.level;

            // Calculate XP needed for the next level
            const xpNeeded = xpForNextLevel(level);
            const progressPercentage = (xp / xpNeeded) * 100;

            // Update the level progress bar
            const progressBar = document.querySelector('.level-progress');
            progressBar.style.width = `${progressPercentage}%`;

            // Update the XP and level display
            document.getElementById('userXP').textContent = `${xp} / ${xpNeeded} XP`;
            document.getElementById('userLevel').textContent = `Level ${level}`;

            // Return the user level to be used for other functions (e.g., wheel initialization)
            return level;
          } else {
              console.error('Failed to fetch user level:', data.error);
              const levelInfo = document.querySelector('.level-info');
              levelInfo.textContent = 'Error fetching XP';
              return 1; // Default to level 1 in case of error
          }
      })
      .catch(error => {
          console.error('Fetch error:', error);
          const levelInfo = document.querySelector('.level-info');
          levelInfo.textContent = 'Error fetching XP';
          return 1; // Default to level 1 in case of error
      });
}

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

// Spin the wheel as a user.
function userSpin() {
  console.log(pageId);
  const username = getUsernameFromUrl();
  const url = `/api/u/${username}/wheel/spin`;

  fetch(url, {
    headers: {    "content-type": "application/json",
    },
    body: JSON.stringify({username: username, pageId: pageId}),
    method: "POST",
  })
  .then(async response => {
    if (!response.ok) { // Handle non-200 responses — surface the server's reason (limit, in-progress, etc.)
        const msg = await response.text().catch(() => '');
        throw new Error(msg || 'Spin already in progress');
    }
    return response.json();
})
  .then(data => {
      if (data.spinId !== undefined) { // Check that the spin actually happened / is not in progress. Don't update spinID if so.
      console.log('Spin ID received:', data.spinId);
      spinId = data.spinId;
      // wager = 5000;
      // displayWagerCost(wager);
      fetchUserBalance(username); // Update the User Balance
      fetchJackpotTotal()
      if (typeof updateSpinsLeft === 'function') updateSpinsLeft(); // refresh the daily counter
      document.getElementById('spinStatus').style.visibility = 'hidden'; // Hide the status message
      }
  })
  .catch(error => {
      console.error('Error making the POST request:', error);
      document.getElementById('spinStatus').textContent = error.message || 'Spin in progress...'; // Show the server's reason
      document.getElementById('spinStatus').style.visibility = 'visible'; // Make the status message visible
  });
}

// Logic for the winning result.
// The wheel landed — tell the server (spinId only). It credits the payout it decided at
// spin time and returns it; we just render the reveal. Nothing here is client-authoritative.
function settleAndReveal() {
  const username = getUsernameFromUrl();
  fetch(`/api/wheel/settle`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spinId: spinId }),
    method: "POST"
  })
  .then(response => response.json())
  .then(data => {
    console.log('Settle response:', data);
    fetchUserBalance(username);
    fetchUserLevel(username);
    if (data.grand) {
      drawResultOverlay("🏆🏆🏆 GRAND JACKPOT! The WHOLE pot: " + Number(data.result).toLocaleString() + " 🏆🏆🏆");
    } else if (data.jackpot) {
      drawResultOverlay("🏆 JACKPOT! You won " + (data.jackpotPct || 0) + "% of the pot: " + Number(data.result).toLocaleString() + " 🏆");
    } else {
      drawResultOverlay(Number(data.result || 0).toLocaleString());
    }
    if (data.result !== undefined) {
      displayPointsReward(data.result);
      displayXPReward(data.xp);
      if (data.levelUp && data.levelUp.leveledUp) {
        console.log("leveledup!!!");
        displayLevelUpAnimation(data.levelUp.levelsGained, data.levelUp.newLevel, data.levelUp.bonusPoints);
      }
      const ss = document.getElementById('spinStatus');
      if (ss) ss.style.visibility = 'hidden';
    }
  })
  .catch(error => {
    console.error('Error settling spin:', error);
  });
}

// Function to display level-up animation
function displayLevelUpAnimation(levelsGained, newLevel, bonusPoints) {
  // Create a parent div for the animation
  const animationContainer = document.createElement('div');
  animationContainer.className = 'arcade-animation-container';
  animationContainer.id = 'animationContainer';

  // Create a div for level-up message
  const levelUpDiv = document.createElement('div');
  levelUpDiv.className = 'arcade-animation-level-up';
  levelUpDiv.textContent = `Level Up (+${levelsGained})! You reached Level ${newLevel}!`;

  // Create a div for bonus points message
  const bonusPointsDiv = document.createElement('div');
  bonusPointsDiv.className = 'arcade-animation-bonus-points';
  bonusPointsDiv.textContent = `You received a PAT ${bonusPoints} level up bonus!`;

  // Create an image element for the dancing frog
  const frogDanceImg = document.createElement('img');
  frogDanceImg.className = 'arcade-animation-frog-dance';
  frogDanceImg.src = `/public/img/dancefrog.gif`;
  frogDanceImg.alt = 'Dancing Frog';

  // Append child elements to the parent container
  animationContainer.appendChild(levelUpDiv);
  animationContainer.appendChild(bonusPointsDiv);
  animationContainer.appendChild(frogDanceImg);

  // Append the parent container to the body
  document.body.appendChild(animationContainer);

  // Apply animation to the container
  animationContainer.style.animation = 'pop-in 0.5s forwards';

  // Remove the animation container after the animation completes
  setTimeout(() => {
    animationContainer.remove();
  }, 5000); // Adjust duration as needed
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

// Function for displaying the winning result
function displayPointsReward(result) {
  const balanceElement = document.getElementById('userBalance');
  const rewardDiv = document.createElement('div');
  rewardDiv.className = 'arcade-animation';
  rewardDiv.id = 'rewardDiv'
  rewardDiv.textContent = `PAT +${result}!`;

  // Position the reward div near the balance
  balanceElement.parentNode.insertBefore(rewardDiv, balanceElement.nextSibling);

  // Apply animation
  rewardDiv.style.animation = 'pop-in 0.5s forwards';

  setTimeout(() => {
      rewardDiv.remove(); // Remove the animation element after it completes
  }, 2500); // Assuming the animation takes 5 seconds
}

// Function for displaying the winning result
function displayWagerCost(wager) {
  const balanceElement = document.getElementById('userBalance');
  const costDiv = document.createElement('div');
  costDiv.className = 'arcade-animation-neg';
  costDiv.textContent = `PAT -${wager}!`;
  const rewardDiv = document.getElementById('rewardDiv');
    if (rewardDiv) {
      rewardDiv.remove(); // Remove the animation element after it completes
    }

  // Position the reward div near the balance
  balanceElement.parentNode.insertBefore(costDiv, balanceElement.nextSibling);

  // Apply animation
  costDiv.style.animation = 'pop-in 0.5s forwards';

  setTimeout(() => {
      costDiv.remove(); // Remove the animation element after it completes
  }, 2500); // Assuming the animation takes 5 seconds
}

    // Function for displaying the winning result
    function displayXPReward(xp) {
      const xpElement = document.getElementById('userXP');
      const xpDiv = document.createElement('div');
      xpDiv.className = 'arcade-animation-xp';
      xpDiv.id = 'xpDiv'
      xpDiv.textContent = `+${Math.round(xp)} XP!`;
    
      // Position the reward div near the balance
      xpElement.parentNode.insertBefore(xpDiv, xpElement.nextSibling);
    
      // Apply animation
      xpDiv.style.animation = 'pop-in 0.5s forwards';
    
      setTimeout(() => {
          xpDiv.remove(); // Remove the animation element after it completes
      }, 2500); // Assuming the animation takes 5 seconds
    }

// Uses the button to initiate a userSpin
spinButton.addEventListener('click', userSpin);

// Function for initiating the user spin from the backend.
function setupSpinListener(username) {
  const eventSource = new EventSource(`/events?type=spin&identifier=${pageId}`);
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

function acknowledgeSpin(ackSpinId) {
  fetch(`/api/u/acknowledge-spin`, {
      method: 'POST',
      headers: {
          'Content-Type': 'application/json'
      },
      body: JSON.stringify({ spinId: ackSpinId })
  })
  .then(response => response.json())
  .then(data => {
      console.log('Acknowledgment response:', data);
      if (data.success) {
          spinId = ackSpinId;            // set the global spinId used by settleAndReveal
          wager = 5000;
          displayWagerCost(wager);
          fetchUserBalance(username);    // Update the User Balance
          spinWheel(data.targetIndex);   // animate to the server-chosen slice
      } else {
          alert('Failed to acknowledge spin:', data.message);
      }
  })
  .catch(error => {
      console.error('Error sending acknowledgment:', error);
  });
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
                eventSource = new EventSource('/events?type=spin&identifier=${pageId}');
                attachEventHandlers(eventSource);
            }, 5000);
        }
    }
}

// Launches Spin Listener
setupSpinListener(username);