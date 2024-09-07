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
centerImage.src = 'http://localhost:3000/public/img/star.gif';

const wheelRadius = canvas.width / 2;
const centerX = canvas.width / 2;
const centerY = canvas.height / 2;

// Set the Wheel Prizes
const segments = [
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
function spinWheel() {
  hideResultOverlay()
  if (isSpinning) return;
  isSpinning = true;

  const spinTimeTotal = 5000 + Math.random() * 10000; // Randomized spin time between 5-10 seconds
  const spinAngleStart = Math.random() * 10 + 10; // Randomized initial spin velocity
  const tickInterval = 2*(2 * Math.PI) / segments.length; // Interval at which the sound should play

  let lastTickAngle = 0;

  let startTime = null;

  function animateSpin(timestamp) {
    if (!startTime) startTime = timestamp;
    const elapsed = timestamp - startTime;
    const progress = Math.min(elapsed / spinTimeTotal, 1);

    const spinAngle = spinAngleStart * (1 - easeOut(progress)) * (Math.PI / 180);
    currentAngle = (currentAngle + spinAngle) % (2 * Math.PI);
    // Play the ticker sound at each segment interval
    if ((currentAngle - lastTickAngle) < 0) {
      lastTickAngle = 0; // Reset when completing a full loop
  }

  if (currentAngle - lastTickAngle >= tickInterval) {
      tickerSound.pause();
      tickerSound.currentTime = 0; // Reset the audio
      tickerSound.play();
      lastTickAngle += tickInterval;
  }
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
  fetch(`http://localhost:3000/api/u/${username}/balance`)
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

// Assuming username is available via some means (e.g., login session)
username = getUsernameFromUrl();
console.log(username);
fetchUsername(username);
fetchUserBalance(username);

// Fetch the Jackpot Total
function fetchJackpotTotal() {
  fetch(`http://localhost:3000/api/jackpot`)
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
  const url = `http://localhost:3000/api/u/${username}/wheel/spin`;

  fetch(url, {
    headers: {    "content-type": "application/json",
    },
    body: JSON.stringify({username: username, pageId: pageId}),
    method: "POST",
  })
  .then(response => {
    if (!response.ok) { // Handle non-200 responses
        throw new Error('Spin already in progress');
    }
    return response.json();
})
  .then(data => {
      if (data.spinId !== undefined) { // Check that the spin actually happened / is not in progress. Don't update spinID if so.
      console.log('Spin ID received:', data.spinId);
      spinId = data.spinId;
      wager = 5000;
      displayWagerCost(wager);
      fetchUserBalance(username); // Update the User Balance
      fetchJackpotTotal()
      document.getElementById('spinStatus').style.visibility = 'hidden'; // Hide the status message
      }
  })
  .catch(error => {
      console.error('Error making the POST request:', error);
      document.getElementById('spinStatus').textContent = 'Spin is currently in progress...'; // Display error message
      document.getElementById('spinStatus').style.visibility = 'visible'; // Make the status message visible
  });
}

// Logic for the winning result.
function determineSpinResult() {
  const totalSize = segments.reduce((acc, seg) => acc + seg.size, 0);
  const segmentAngle = (2 * Math.PI) / totalSize;

  // Adjust current angle so that 0 degrees aligns with the arrow (top position)
  // CurrentAngle represents the change in the startangle and endangle so we can know the length of rotations to unwind, and correspond this with the number of segments and size of segment to get to the same position.
  let angle = (2 * Math.PI - ((currentAngle + ((2 * Math.PI) / 4)) % (2 * Math.PI))) % (2 * Math.PI); // The 0 position is on the right by default, so we add a quarter rotation to the current angle to compensate.
  let cumulativeAngle = 0;

  for (let i = 0; i < segments.length; i++) {
    cumulativeAngle += (segments[i].size / totalSize) * 2 * Math.PI;
    if (angle <= cumulativeAngle) {
      const result = segments[i].label;
      // Display the result on the page.
      drawResultOverlay(result);
      // Send result to backend.
      const username = getUsernameFromUrl();
      const url = `http://localhost:3000/api/u/${username}/wheel/spin/result`;
      fetch(url, {
        headers: {    "content-type": "application/json",
        },
        body: JSON.stringify({ spinId: spinId, result: result }),
        method: "POST"
      })
      .then(response => response.json())
      .then(data => {
          console.log('Server response:', data.message);
          fetchUserBalance(username);
          // Additional actions based on response can be handled here
          if (data.result) {
            displayPointsReward(data.result);
            document.getElementById('spinStatus').style.visibility = 'hidden'; // Hide the status message
          }
      })
      .catch(error => {
          console.error('Error sending spin result:', error);
      });
      break;
    }
  }
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
  rewardDiv.textContent = `+${result} Points!`;

  // Position the reward div near the balance
  balanceElement.parentNode.insertBefore(rewardDiv, balanceElement.nextSibling);

  // Apply animation
  rewardDiv.style.animation = 'pop-in 0.5s forwards';

  setTimeout(() => {
      rewardDiv.remove(); // Remove the animation element after it completes
  }, 2000); // Assuming the animation takes 5 seconds
}

// Function for displaying the winning result
function displayWagerCost(wager) {
  const balanceElement = document.getElementById('userBalance');
  const rewardDiv = document.createElement('div');
  rewardDiv.className = 'arcade-animation-neg';
  rewardDiv.textContent = `-${wager} Points!`;

  // Position the reward div near the balance
  balanceElement.parentNode.insertBefore(rewardDiv, balanceElement.nextSibling);

  // Apply animation
  rewardDiv.style.animation = 'pop-in 0.5s forwards';

  setTimeout(() => {
      rewardDiv.remove(); // Remove the animation element after it completes
  }, 2000); // Assuming the animation takes 5 seconds
}

// Uses the button to initiate a userSpin
spinButton.addEventListener('click', userSpin);

// Function for initiating the user spin from the backend.
function setupSpinListener(username) {
  const eventSource = new EventSource(`/events?type=spin&identifier=${pageId}`);
  console.log(eventSource);
  eventSource.onmessage = function(event) {
      const data = JSON.parse(event.data);
      console.log('Received command to start spinning:', data);
      const segments = data.message.split(' '); // Split the path by ' '
      // Assuming the structure /u/username/wheel, username would be at index 2
      wheelSpinner = segments[4];
      spinId = segments[2];
      spinWheel(); // Function to start the wheel spinning
  };

  eventSource.onerror = function(event) {
      console.error('EventSource failed:', event);
      eventSource.close();
  };
}

// Launches Spin Listener
setupSpinListener(username);

drawWheel();