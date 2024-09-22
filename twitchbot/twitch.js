require("dotenv").config();
const tmi = require("tmi.js");
const { runQuery, getQuery } = require("../dbUtils");
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");
const bcrypt = require("bcrypt");
const EventSource = require("eventsource");
const {
  registerUser,
  loginUser,
  updateUsername,
  updateEmail,
  updatePassword,
  updateDisplayname,
  updateAvatar,
  updateDiscordId,
  updateTwitchId,
  awardBadge,
  xpForNextLevel,
  updateLevel,
} = require("../user.controller");

const client = new tmi.Client({
  connection: {
    secure: true,
    reconnect: true,
  },
  identity: {
    username: "wheel_of_misfortune",
    password: process.env.TWITCH_OAUTH_TOKEN,
  },
  channels: ["publicaccess_ttv"],
});

client.connect();

// thisArg - context in which to call the function; 'this' in the function's body
// fn - function to execute on a cooldown
// timeout - number of milliseconds to wait before allowing fn to be called again
var cooldown = function (thisArg, fn, timeout) {
  var onCooldown = false;

  // return a function that can be called the same way as the wrapped function
  return function (/* args */) {
    // only call the original function if it is not on cooldown
    if (!onCooldown) {
      // not on cooldown, so call the function with the correct context
      // and the arguments with which this wrapper was called
      fn.apply(thisArg, arguments);

      // set the cooldown flag so subsequent calls will not execute the function
      onCooldown = true;

      // wait <timeout> milliseconds before allowing the function to be called again
      setTimeout(function () {
        onCooldown = false;
      }, timeout);
    }
  };
};

var clientSayHello = cooldown(client, client.say, 5000);

let currentRaffleParticipants = new Set();
let raffleTimeout;

const blacklist = [""];
let userCooldownArray = [];
let globalCooldownArray = [];
var ucd = new Object();
var gcd = new Object();

client.on("message", async (channel, tags, message, self) => {
  if (self) return; // Ignore bot's own messages
  const twitchUser = tags;
  const twitchId = tags["user-id"];
  const displayName = tags["display-name"];
  const profileImage = `https://static-cdn.jtvnw.net/jtv_user_pictures/${twitchId}-profile_image-300x300.png`; // You can replace with actual profile image fetching logic if necessary
  const badges = tags.badges || {};
  const isSub = badges.subscriber || badges.founder;

  // Add the user to the current raffle
  onChatMessage(twitchUser);

  // Extract command and arguments
  const args = message.trim().split(" ");
  if (message === "!spin") {
    if (userCooldownArray.indexOf(twitchId) == -1) {
      let ucdtimer = 30000;
      if (isSub) {
        ucdtimer = 5000;
      }
      ucd[`${twitchId}`] = Math.floor(Date.now() + ucdtimer);
      userCooldownArray.push(twitchId);
      setTimeout(() => {
        userCooldownArray = userCooldownArray.filter((u) => u !== twitchId);
      }, ucdtimer);
      handleSpinCommand(channel, twitchId, displayName, profileImage);
    } else {
      var ucds =
        (Math.floor(ucd[`${twitchId}`]) - Math.floor(Date.now())) / 1000 / 60;
      client.say(
        channel,
        `@${displayName}, please wait ${ucds} minutes before spinning again. (User Cooldown)`
      );
    }
  }

  if (message === "!help") {
    helpMenu(channel);
  }

  if (message === "hi") {
    clientSayHello(channel, `howdy @${displayName}`);
  }

  if (message === "!balance") {
    handleBalanceCommand(channel, twitchId, displayName, profileImage);
  }

  if (args[0] === "!tip" && args.length === 3) {
    const recipientDisplayName = args[1]; // Username of the recipient
    const amount = parseInt(args[2], 10); // Amount of points to tip

    if (isNaN(amount) || amount <= 0) {
      return client.say(
        channel,
        `@${displayName}, please provide a valid tip amount.`
      );
    }

    handleTipCommand(
      channel,
      twitchId,
      displayName,
      recipientDisplayName,
      amount
    );
  }
});

// Creates a new user with Twitch
async function createTwitchUser(twitchId, displayName, profileImage) {
  try {
    const password = Math.random().toString(36).substring(2, 15);
    const hashedPassword = await bcrypt.hash(password, 12);

    // Check if the username is already taken
    let username = displayName;
    username = await generateUniqueUsername(username);
    console.log(username);
    const newUser = {
      username: username, // Use the unique username
      displayname: displayName,
      email: Math.random().toString(36).substring(2, 15), // No email for Twitch-based users unless you have it
      password: hashedPassword,
      twitchId: twitchId,
      twitchDisplayname: displayName,
      avatar: profileImage || "/public/img/avatar.png",
      points_balance: 50000,
    };

    const response = await axios.post(
      process.env.BACKEND_BASE_URL+`/api/users/twitch/register`,
      newUser
    );
    return response.data.user; // Returns the new user data
  } catch (error) {
    console.error("Error creating new Twitch user:", error.message);
    return null;
  }
}

// In case of username collision, generate a unique username.
async function generateUniqueUsername(baseUsername) {
  let username = baseUsername;
  let isUnique = false;
  let counter = 1;

  while (!isUnique) {
    // Check if the username already exists in the database
    const existingUserResponse = await axios.get(
      process.env.BACKEND_BASE_URL+`/api/users/username/${username}`
    );
    if (existingUserResponse.data && existingUserResponse.data.exists) {
      // Username exists, append a number and check again
      username = `${baseUsername}${counter}`;
      counter++;
    } else {
      // Username is unique
      isUnique = true;
    }
  }

  return username; // Return the unique username
}

// Find an existing user with TwitchId or automatically create a new user for spins.
async function findOrCreateTwitchUser(twitchId, displayName, profileImage) {
  try {
    // Check if the user already exists in the backend
    const userResponse = await axios.get(process.env.BACKEND_BASE_URL+`/api/users/twitch/${twitchId}`);

    if (userResponse.data && userResponse.data.user) {
      // User found, return the existing user data
      return userResponse.data.user;
    } else {
      // This block may not be reached since a 404 error will be thrown
      // Proceed to create the user in the catch block
    }
  } catch (error) {
    if (error.response && error.response.status === 404) {
      // User not found, create a new one
      console.log(`Twitch user with ID ${twitchId} not found. Creating new user...`);
      const newUser = await createTwitchUser(twitchId, displayName, profileImage);
      if (newUser) {
        console.log(`New user ${newUser.username} created.`);
        return newUser;
      } else {
        throw new Error("Error creating new Twitch user");
      }
    } else {
      // Other errors (network issues, server errors, etc.)
      console.error("Error finding or creating Twitch user:", error.message);
      throw error;
    }
  }
}

// Find a users balance
async function findUserBalance(twitchId) {
  try {
    // Step 1: Check if the user already exists in the backend
    const userResponse = await axios.get(
      process.env.BACKEND_BASE_URL+`/api/users/twitch/${twitchId}`
    );
    if (userResponse.data && userResponse.data.user) {
      // User found, return the existing user data
      const currentUser = userResponse.data.user;
      console.log(`User ${currentUser.username} found.`);
      const userBalanceResponse = await axios.get(
        process.env.BACKEND_BASE_URL+`/api/u/${currentUser.username}/balance`
      );
      const userBalance = userBalanceResponse.data.balance;
      return userBalance;
    } else {
      // User doesn't exist, create a new one
      console.log(`Twitch user with ID ${twitchId} not found.`);
    }
  } catch (error) {
    console.error("Error finding Twitch user:", error.message);
    throw error;
  }
}

// COMMANDS LOGIC

// !spin
async function handleSpinCommand(channel, twitchId, displayName, profileImage) {
  // Logic to trigger the spin based on the user info
  const user = await findOrCreateTwitchUser(
    twitchId,
    displayName,
    profileImage
  );
  console.log(`Spinning the wheel for ${user.username}`);
  const url = process.env.BACKEND_BASE_URL+`/api/g/wheel/chatspin`;

  fetch(url, {
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      username: user.username,
      password: process.env.TWITCH_BOT_TOKEN,
    }),
    method: "POST",
  })
    .then((response) => {
      if (!response.ok) {
        // Handle non-200 responses
        throw new Error("Spin already in progress");
      }
      return response.json();
    })
    .then((data) => {
      if (data.spinId !== undefined) {
        // Check that the spin actually happened / is not in progress. Don't update spinId if so.
        console.log("Spin ID received:", data.spinId);
        spinId = data.spinId;
        // Store spinId in local storage or a global variable
        // localStorage.setItem('currentSpinID', spinId);
        // Set up SSE listener with this spinId
        console.log(displayName);
        setupWagerListener(spinId, channel, twitchId, displayName);
        setupResultsListener(spinId, channel, twitchId, displayName);
        // fetchUserBalance(user); // Update the User Balance
        // document.getElementById('spinStatus').style.visibility = 'hidden'; // Hide the status message
      }
    })
    .catch((error) => {
      console.error("Error making the POST request:", error);
      client.say(channel, `@${displayName}, spin is currently in progress....`);
      // document.getElementById('spinStatus').textContent = 'Spin is currently in progress...'; // Display error message
      // document.getElementById('spinStatus').style.visibility = 'visible'; // Make the status message visible
      // setTimeout(() => {
      //     document.getElementById('spinStatus').style.visibility = 'hidden'; // Remove the animation element after it completes
      // }, 2000);
    });
}

// EVENT LISTENERS

async function setupResultsListener(spinId, channel, twitchId, displayName) {
  const eventSource = new EventSource(
    process.env.BACKEND_BASE_URL+`/events?type=results&identifier=${spinId}`
  );

  eventSource.onmessage = async function (event) {
    const result = JSON.parse(event.data);
    const spinnerBalance = await findUserBalance(twitchId);
    console.log("Spin result received:", result);
    if (result.result > 1000000) {
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      client.say(
        channel,
        `PAT ${result.result} JACKPOT @${displayName}!!!!!!!!`
      );
      clientSayPrize(
        channel,
        `YOU WON THE PAT ${result.result} JACKPOT AND GAINED ${result.xp} XP @${displayName} (PAT ${spinnerBalance})!!!!!!!! YOU ARE AMAZING AND SO COOL!`
      );
    } else {
      // Update UI based on the result
      client.say(
        channel,
        `You won PAT ${result.result} and gained ${result.xp} XP, @${displayName} (PAT ${spinnerBalance}).`
      );
    }
    // fetchUserBalance(user);
    eventSource.close();
  };

  eventSource.onerror = function (event) {
    console.error("EventSource failed:", event);
    eventSource.close();
  };
}

async function setupWagerListener(spinId, channel, twitchId, displayName) {
  const eventSource = new EventSource(
    process.env.BACKEND_BASE_URL+`/events?type=spin&identifier=${spinId}`
  );

  eventSource.onmessage = async function (event) {
    const data = JSON.parse(event.data);
    const spinnerBalance = await findUserBalance(twitchId);
    console.log(spinnerBalance);
    console.log("Spin command received:", data);
    if (data.message.includes("public spinid") && data.spinId) {
      console.log("Spin command received:", data);
      wager = 5000;
      client.say(
        channel,
        `yes yes @${displayName} (PAT ${spinnerBalance}). Spinning the wheel for PAT ${wager}, good luck!`
      );
    }
    // Update UI based on the result
    eventSource.close();
  };

  eventSource.onerror = function (event) {
    console.error("EventSource failed:", event);
    eventSource.close();
  };
}

// !help
function helpMenu(channel) {
  // client.say(channel, `!hotline - Call into the stream.`)
  client.say(channel, `!balance - Check your PAT balance.`);
  client.say(channel, `!level - Check your level and XP.`);
  client.say(channel, `!tip [user] [amount] - Transfer PAT to a user.`);
  client.say(channel, `!spin - Spin the Wheel of Misfortune.`);
}

// !balance
async function handleBalanceCommand(
  channel,
  twitchId,
  displayName,
  profileImage
) {
  try {
    // Step 1: Ensure the user exists (either found or created)
    const user = await findOrCreateTwitchUser(
      twitchId,
      displayName,
      profileImage
    );

    // Step 2: Fetch the user's balance using the API endpoint
    const balanceResponse = await axios.get(
      process.env.BACKEND_BASE_URL+`/api/u/${user.username}/balance`
    );

    if (
      balanceResponse.data &&
      balanceResponse.data.balance !== undefined &&
      balanceResponse.data.balance !== 0
    ) {
      const balance = balanceResponse.data.balance;
      client.say(
        channel,
        `Howdy @${displayName}, you currently have PAT ${balance}.`
      );
    } else if (
      balanceResponse.data.balance == null ||
      balanceResponse.data.balance == 0
    ) {
      client.say(
        channel,
        `Howdy @${displayName}. You have no PAT. Sign up at https://publicaccess.tv to learn how to get some.`
      );
    } else {
      throw new Error("Balance data is not available");
    }
  } catch (error) {
    console.error(`Error fetching balance for ${displayName}:`, error.message);
    client.say(
      channel,
      `@${displayName}, there was an error fetching your balance.`
    );
  }
}

// !tip
async function handleTipCommand(
  channel,
  senderTwitchId,
  senderDisplayName,
  recipientDisplayName,
  amount
) {
  try {
    // Step 1: Remove the '@' symbol from the recipient's display name if it exists
    const cleanRecipientDisplayName = recipientDisplayName.replace(/^@/, "");

    // Step 2: Ensure sender exists or create a new user
    const sender = await findOrCreateTwitchUser(
      senderTwitchId,
      senderDisplayName
    );

    // Step 3: Check if the recipient exists using the endpoint
    let recipient;
    try {
      const recipientResponse = await axios.get(
        process.env.BACKEND_BASE_URL+`/api/users/twitch/displayname/${cleanRecipientDisplayName}`
      );
      recipient = recipientResponse.data.user;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        // Handle recipient not found
        return client.say(
          channel,
          `@${senderDisplayName}, the user ${cleanRecipientDisplayName} does not exist.`
        );
      } else {
        // Handle other errors
        console.error(
          `Error fetching recipient ${cleanRecipientDisplayName}:`,
          error
        );
        return client.say(
          channel,
          `@${senderDisplayName}, there was an error retrieving the recipient's information.`
        );
      }
    }

    // Step 4: Send tip using the existing /chattip endpoint
    try {
      const tipResponse = await axios.post(
        process.env.BACKEND_BASE_URL+`/u/${recipient.username}/chattip`,
        {
          amount: amount,
          sender: sender.username,
          recipient: recipient.username,
          password: process.env.TWITCH_BOT_TOKEN,
        }
      );

      if (
        tipResponse.data &&
        tipResponse.data.message === "Tip sent successfully."
      ) {
        // Fetch updated balances for both sender and recipient
        const [senderBalanceResponse, recipientBalanceResponse] =
          await Promise.all([
            axios.get(process.env.BACKEND_BASE_URL+`/api/u/${sender.username}/balance`),
            axios.get(
              process.env.BACKEND_BASE_URL+`/api/u/${recipient.username}/balance`
            ),
          ]);

        const senderBalance = senderBalanceResponse.data.balance;
        const recipientBalance = recipientBalanceResponse.data.balance;

        client.say(
          channel,
          `@${senderDisplayName} (PAT ${senderBalance}) successfully tipped PAT ${amount} to ${cleanRecipientDisplayName} (PAT ${recipientBalance}).`
        );
      } else {
        client.say(
          channel,
          `@${senderDisplayName}, there was an issue with the tip.`
        );
      }
    } catch (error) {
      if (
        error.response &&
        error.response.status === 400 &&
        error.response.data === "Insufficient balance"
      ) {
        // Handle insufficient balance error
        const senderBalanceResponse = await axios.get(
          process.env.BACKEND_BASE_URL+`/api/u/${sender.username}/balance`
        );
        const senderBalance = senderBalanceResponse.data.balance;
        return client.say(
          channel,
          `@${senderDisplayName}, you do not have enough PAT to tip ${amount}. Your balance is PAT ${senderBalance}.`
        );
      } else {
        console.error(
          `Error sending tip from ${senderDisplayName} to ${recipientDisplayName}:`,
          error
        );
        client.say(
          channel,
          `@${senderDisplayName}, there was an error processing your tip.`
        );
      }
    }
  } catch (error) {
    console.error(
      `Error processing tip from ${senderDisplayName} to ${recipientDisplayName}:`,
      error
    );
    client.say(
      channel,
      `@${senderDisplayName}, there was an error processing your tip.`
    );
  }
}

// Function to start a new raffle
function startRaffle(channel) {
  console.log("Raffle started!");

  // Clear any existing participants
  currentRaffleParticipants.clear();

  // Determine a random duration between 15 and 60 minutes
  const raffleDurationMinutes = Math.floor(Math.random() * (60 - 15 + 1)) + 15;
  const raffleDurationMs = raffleDurationMinutes * 60 * 1000;

  console.log(`Raffle will end in ${raffleDurationMinutes} minutes`);

  // Schedule the end of the raffle
  raffleTimeout = setTimeout(() => {
    endRaffle(channel, raffleDurationMinutes);
  }, raffleDurationMs);
}

// Function to handle chat messages (enter users into the raffle)
async function onChatMessage(twitchUser) {
  const twitchId = twitchUser["user-id"]; // Twitch user ID
  const displayName = twitchUser["display-name"];
  const profileImage = twitchUser["profile_image_url"] || null;
  if (twitchId == undefined) return;
  try {
    // Ensure that the user exists in your backend using findOrCreateTwitchUser
    const user = await findOrCreateTwitchUser(
      twitchId,
      displayName,
      profileImage
    );

    if (user && user.userId) {
      // Check if the user is already in the raffle
      if (!currentRaffleParticipants.has(user.twitchId)) {
        // Add the backend userId to the raffle participants
        currentRaffleParticipants.add(user.twitchId);
        console.log(`User ${user.username} added to the raffle.`);
      } else {
        console.log(`User ${user.username} is already in the raffle.`);
      }
    }
  } catch (error) {
    console.error("Error adding user to raffle:", error.message);
  }
}

async function exchangeChannelPoints(points, twitchDisplayname) {
     // Step 3: Check if the recipient exists using the endpoint
     let recipient;
     const channel = 'publicaccess_ttv'
     try {
       const recipientResponse = await axios.get(
         process.env.BACKEND_BASE_URL+`/api/users/twitch/displayname/${twitchDisplayname}`
       );
       recipient = recipientResponse.data.user;
     } catch (error) {
       if (error.response && error.response.status === 404) {
         // Handle recipient not found
         return client.say(
           channel,
           `@${twitchDisplayname}, your PATV account was not found.`
         );
       } else {
         // Handle other errors
         console.error(
           `Error fetching recipient ${twitchDisplayname}:`,
           error
         );
         return client.say(
           channel,
           `@${twitchDisplayname}, there was an error retrieving your information.`
         );
       }
     }
     // Send the result to the backend
  try {
    await axios.post(process.env.BACKEND_BASE_URL+`/api/bonus/chatwinner`, {
      userId: recipient.userId,
      type: "twitch-channelpoints",
      amount: points,
      password: process.env.TWITCH_BOT_TOKEN,
    });
    console.log("Raffle winner logged in backend.");
    client.say(
      channel,
      `@${twitchDisplayname} exchanged channel points for PAT ${points}!`
    );
  } catch (error) {
    console.error("Failed to log channel point redemption.", error);
  }
}

// Function to end the raffle and select a winner
async function endRaffle(channel, raffleDurationMinutes) {
  if (currentRaffleParticipants.size === 0) {
    console.log("No participants in the raffle.");
    startRaffle(channel); // Start a new raffle
    return;
  }

  // Convert Set to an array and select a random user
  const participantsArray = Array.from(currentRaffleParticipants);
  const randomIndex = Math.floor(Math.random() * participantsArray.length);
  const winnerId = participantsArray[randomIndex];
  const winnerBalance = await findUserBalance(winnerId);
  let displayName = "";

  // Find the displayname of for the winnerId
  const userResponse = await axios.get(
    process.env.BACKEND_BASE_URL+`/api/users/twitch/${winnerId}`
  );

  if (userResponse.data && userResponse.data.user) {
    // User found, return the existing user data
    displayName = userResponse.data.user.twitchDisplayname;
    userId = userResponse.data.user.userId;
  }

  // Determine a random prize between 100 and 500 multiplied by the raffle duration
  const randomPrize =
    (Math.floor(Math.random() * 401) + 100) * raffleDurationMinutes;

  console.log(
    `User with ID ${winnerId} won the raffle with a prize of ${randomPrize} points!`
  );

  // Send the result to the backend
  try {
    await axios.post(process.env.BACKEND_BASE_URL+`/api/bonus/chatwinner`, {
      userId: userId,
      type: "twitch-raffle",
      amount: randomPrize,
      password: process.env.TWITCH_BOT_TOKEN,
    });
    console.log("Raffle winner logged in backend.");
    client.say(
      channel,
      `@${displayName} (PAT ${winnerBalance}) won the random chat raffle with a prize of PAT ${randomPrize}!`
    );
  } catch (error) {
    console.error("Failed to log raffle winner:", error);
  }

  // Start a new raffle
  startRaffle(channel);
}

// Initialization when the bot starts
function initializeBot() {
  startRaffle("#publicaccess_ttv");
}

// Initialize the bot
initializeBot();

module.exports = {
  exchangeChannelPoints
}