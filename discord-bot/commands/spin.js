const { SlashCommandBuilder } = require('@discordjs/builders');
const axios = require('axios');
const { findOrCreateDiscordUser } = require('../userUtils');
const EventSource = require('eventsource');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('spin')
    .setDescription('Spin the wheel and try your luck!'),
  
  async execute(interaction) {
    const discordUser = interaction.user;

    try {
      // Step 1: Defer the reply to prevent timeouts
      await interaction.deferReply();

      // Step 2: Ensure the user exists (either found or created)
      const user = await findOrCreateDiscordUser(
        discordUser.id,
        discordUser.username,
        discordUser.displayAvatarURL()
      );

      console.log(`Spinning the wheel for ${user.username}`);
      const url = process.env.BACKEND_BASE_URL+`/api/g/wheel/chatspin`;

      // Step 3: Make the spin request to the backend
      const spinResponse = await axios.post(url, {
        username: user.username,
        password: process.env.DISCORD_BOT_TOKEN,
      });

      // Step 4: Check if the spin is successful
      if (spinResponse.data.spinId) {
        const spinId = spinResponse.data.spinId;
        console.log(spinId);
        // You can reply to the interaction first and follow-up later
        
        interaction.editReply(`Spinning the wheel for you, ${discordUser.username}!`);
        setupWagerListener(spinId, interaction);
        // Set up listeners for the wager and results
        
        await setupResultsListener(spinId, interaction, user);
      } else {
        throw new Error("Spin request failed.");
      }
    } catch (error) {
      console.error(`Error during spin for ${discordUser.username}:`, error.message);
      interaction.editReply(`Sorry ${discordUser.username}, something went wrong while spinning.`);
    }
  },
};

// EVENT LISTENERS

async function setupResultsListener(spinId, interaction, user) {
  
  const eventSource = new EventSource(
    process.env.BACKEND_BASE_URL+`/events?type=results&identifier=${spinId}`
  );  

  eventSource.onmessage = async function (event) {
    const result = JSON.parse(event.data);
    console.log("Spin result received:", result);

    const spinnerBalanceResponse = await axios.get(process.env.BACKEND_BASE_URL+`/api/u/${user.username}/balance`);
    const spinnerBalance = spinnerBalanceResponse.data.balance;

    if (result.result > 1000000) {
      await interaction.followUp(
        `PAT ${result.result} JACKPOT for ${interaction.user}!!!! (New Balance: PAT ${spinnerBalance})`
      );
    } else {
      await interaction.followUp(
        `You won PAT ${result.result} and gained ${result.xp} XP, ${interaction.user} (New Balance: PAT ${spinnerBalance}).`
      );
    }

    eventSource.close();
  };

  eventSource.onerror = function (event) {
    console.error("EventSource failed:", event);
    eventSource.close();
  };
}

// Function to set up wager listener, now returns a Promise
function setupWagerListenerWithPromise(spinId, interaction) {
  return new Promise((resolve, reject) => {
    const eventSourceUrl = `${process.env.BACKEND_BASE_URL}/events?type=spin&identifier=${spinId}`;
    console.log(`[SpinID: ${spinId}][WAGER] Setting up EventSource to: ${eventSourceUrl}`);
    const eventSource = new EventSource(eventSourceUrl);
    let processed = false; // To prevent multiple resolves/rejects

    const timeoutDuration = 15000; // 15-second timeout for the wager event
    const timeoutId = setTimeout(() => {
      if (processed) return;
      processed = true;
      console.warn(`[SpinID: ${spinId}][WAGER] Listener timed out after ${timeoutDuration}ms.`);
      eventSource.close();
      reject(new Error('Wager event listener timed out.'));
    }, timeoutDuration);

    eventSource.onmessage = async function (event) {
      if (processed) return; // Already handled by a previous message, error, or timeout

      console.log(`[SpinID: ${spinId}][WAGER] RAW EVENT RECEIVED: data=${event.data}`);
      let data;
      try {
        data = JSON.parse(event.data);
        console.log(`[SpinID: ${spinId}][WAGER] PARSED DATA:`, data);
      } catch (parseError) {
        console.error(`[SpinID: ${spinId}][WAGER] JSON parse error:`, parseError, `Raw data: ${event.data}`);
        // If parsing fails, this message is not what we expect.
        // We'll keep listening for a valid message or until timeout.
        return;
      }

      // Check if this is the specific message we are looking for
      if (data.message && data.message.includes("public spinid") && data.spinId === spinId) {
        processed = true; // Mark as processed
        clearTimeout(timeoutId); // Clear the timeout

        try {
          // Username extraction: This part is fragile and highly dependent on the exact message format.
          // Original: var spinnerUsername = data.message.split(" ")[4];
          // Consider if interaction.user.username is always the spinner for this message.
          // Or if the backend can send `username` as a direct field in `data`.
          let spinnerUsername = interaction.user.username; // Default to the interaction user
          const parts = data.message.split(" ");
          if (parts.length > 4 && parts[2] === spinId && parts[3] === "from") { // Example: "public spinid {spinId} from {username}"
             spinnerUsername = parts[4];
             console.log(`[SpinID: ${spinId}][WAGER] Extracted spinnerUsername: ${spinnerUsername} using specific format.`);
          } else if (data.message.toLowerCase().includes(interaction.user.username.toLowerCase())) {
            // Fallback if the user's name is simply in the message string
             console.log(`[SpinID: ${spinId}][WAGER] Using interaction.user.username as spinnerUsername was found in message.`);
          } else if (parts.length > 4) {
            // Fallback to original potentially fragile split if specific formats don't match
            spinnerUsername = parts[4];
            console.warn(`[SpinID: ${spinId}][WAGER] Extracted spinnerUsername using original split(" ")[4]: ${spinnerUsername}. This might be fragile.`);
          } else {
            console.warn(`[SpinID: ${spinId}][WAGER] Could not reliably extract spinnerUsername from message "${data.message}". Defaulting to interaction user: ${interaction.user.username}.`);
          }
          
          const spinnerBalanceResponse = await axios.get(`${process.env.BACKEND_BASE_URL}/api/u/${spinnerUsername}/balance`);
          const spinnerBalance = spinnerBalanceResponse.data.balance;

          await interaction.editReply(
            `Spinning the wheel for PAT 5000, good luck! Your current balance is PAT ${spinnerBalance}.`
          );
          console.log(`[SpinID: ${spinId}][WAGER] Discord message successfully edited with wager info.`);
          eventSource.close(); // Close AFTER successful processing
          resolve(); // Resolve the promise
        } catch (error) {
          console.error(`[SpinID: ${spinId}][WAGER] Error processing target event or editing reply:`, error.message);
          eventSource.close(); // Close on error
          reject(error); // Reject the promise
        }
      } else {
        // This was a message, but not the one we're looking for.
        // Log it and continue listening (do not close, do not resolve/reject).
        console.log(`[SpinID: ${spinId}][WAGER] Received non-target message. Data:`, data, `Still listening...`);
      }
    };

    eventSource.onerror = function (errEvent) {
      if (processed) return;
      processed = true;
      clearTimeout(timeoutId);
      const errorMessage = errEvent.message || (errEvent.type ? `EventSource error type: ${errEvent.type}` : 'Unknown EventSource error');
      console.error(`[SpinID: ${spinId}][WAGER] EventSource error:`, errorMessage, errEvent);
      eventSource.close();
      reject(new Error(`Wager EventSource error: ${errorMessage}`));
    };
  });
}

