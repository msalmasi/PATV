const { SlashCommandBuilder } = require('@discordjs/builders');
const axios = require('axios');
const { findOrCreateDiscordUser } = require('../userUtils'); // Ensure this path is correct
const EventSource = require('eventsource');

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

// setupResultsListener can remain as is, or be refactored similarly if it also needs more robustness
async function setupResultsListener(spinId, interaction, user) {
  const eventSourceUrl = `${process.env.BACKEND_BASE_URL}/events?type=results&identifier=${spinId}`;
  console.log(`[SpinID: ${spinId}][RESULTS] Setting up EventSource to: ${eventSourceUrl}`);
  const eventSource = new EventSource(eventSourceUrl);
  let processed = false;

  const timeoutDuration = 30000; // 30-second timeout for results
  const timeoutId = setTimeout(() => {
    if (processed) return;
    processed = true;
    console.warn(`[SpinID: ${spinId}][RESULTS] Listener timed out after ${timeoutDuration}ms.`);
    eventSource.close();
    interaction.followUp(`Sorry ${interaction.user.username}, timed out waiting for spin results (Spin ID: ${spinId}).`).catch(e => {});
    // Optionally reject a promise if this function were to return one
  }, timeoutDuration);

  eventSource.onmessage = async function (event) {
    if (processed) return;
    processed = true;
    clearTimeout(timeoutId);

    console.log(`[SpinID: ${spinId}][RESULTS] RAW EVENT RECEIVED: data=${event.data}`);
    const result = JSON.parse(event.data); // Assuming result event data is always valid JSON
    console.log(`[SpinID: ${spinId}][RESULTS] PARSED DATA:`, result);

    try {
        const spinnerBalanceResponse = await axios.get(`${process.env.BACKEND_BASE_URL}/api/u/${user.username}/balance`);
        const spinnerBalance = spinnerBalanceResponse.data.balance;

        if (result.result > 1000000) { // Ensure result.result is the numeric win amount
        await interaction.followUp(
            `PAT ${result.result} JACKPOT for ${interaction.user}!!!! (New Balance: PAT ${spinnerBalance})`
        );
        } else {
        await interaction.followUp(
            `You won PAT ${result.result} and gained ${result.xp || 0} XP, ${interaction.user} (New Balance: PAT ${spinnerBalance}).`
        );
        }
    } catch (e) {
        console.error(`[SpinID: ${spinId}][RESULTS] Error processing result or sending followup:`, e.message);
        await interaction.followUp(`Got your spin result (Won PAT ${result.result}), but there was an issue displaying full details, ${interaction.user}.`).catch(err => {});
    } finally {
        eventSource.close();
    }
  };

  eventSource.onerror = function (errEvent) {
    if (processed) return;
    processed = true;
    clearTimeout(timeoutId);
    const errorMessage = errEvent.message || (errEvent.type ? `EventSource error type: ${errEvent.type}` : 'Unknown EventSource error');
    console.error(`[SpinID: ${spinId}][RESULTS] EventSource error:`, errorMessage, errEvent);
    eventSource.close();
    interaction.followUp(`Sorry ${interaction.user.username}, there was an error receiving spin results (Spin ID: ${spinId}).`).catch(e => {});
  };
}


module.exports = {
  data: new SlashCommandBuilder()
    .setName('spin')
    .setDescription('Spin the wheel and try your luck!'),

  async execute(interaction) {
    const discordUser = interaction.user;
    let spinId; // Define spinId here for broader scope in catch block

    try {
      await interaction.deferReply();

      const user = await findOrCreateDiscordUser(
        discordUser.id,
        discordUser.username,
        discordUser.displayAvatarURL()
      );

      console.log(`[User: ${user.username}] Initiating spin.`);
      const url = `${process.env.BACKEND_BASE_URL}/api/g/wheel/chatspin`;

      const spinResponse = await axios.post(url, {
        username: user.username,
        password: process.env.DISCORD_BOT_TOKEN, // Ensure this is the intended auth mechanism
      });

      if (spinResponse.data && spinResponse.data.spinId) {
        spinId = spinResponse.data.spinId;
        console.log(`[SpinID: ${spinId}] Spin request successful. Got spinId.`);
        
        // Initial reply, can be a placeholder before wager confirmation
        await interaction.editReply(`Processing your spin, ${discordUser.username} (ID: ${spinId})...`);

        try {
          // Await the wager listener to process the specific event and edit the reply
          await setupWagerListenerWithPromise(spinId, interaction);
          console.log(`[SpinID: ${spinId}] Wager listener promise resolved (message should be edited).`);
        } catch (wagerError) {
          console.error(`[SpinID: ${spinId}] Wager listener failed or timed out:`, wagerError.message);
          // If wager confirmation is critical, you might send a specific followup
          // For example: await interaction.followUp(`Couldn't confirm wager details for spin ${spinId}. Proceeding to results...`);
          // If it's non-critical, the current flow will just move to results.
        }
        
        // Proceed to setup results listener
        // This setup is still async in terms of when events arrive, but the setup itself is quick.
        // If sequential display is critical (e.g. results ONLY after wager confirmed visually for a time),
        // you might add a small delay or make setupResultsListener also promise-based for its first event.
        setupResultsListener(spinId, interaction, user); // Fire-and-forget the setup of this listener
        console.log(`[SpinID: ${spinId}] Results listener setup initiated.`);

      } else {
        console.error("[No SpinID] Spin request to backend failed or did not return a spinId. Response:", spinResponse.data);
        await interaction.editReply("Sorry, your spin request to the backend failed.");
        return; // Stop execution if no spinId
      }
    } catch (error) {
      const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
      console.error(`[SpinID: ${spinId || 'N/A'}][User: ${discordUser.username}] Critical error during spin command:`, errorMessage, error.stack);
      // Ensure reply is edited or followed up, even on error
      const errorReplyMessage = `Sorry ${discordUser.username}, an unexpected error occurred with your spin.`;
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(errorReplyMessage).catch(e => {
            console.error(`[SpinID: ${spinId || 'N/A'}] Failed to editReply on error, trying followUp:`, e);
            interaction.followUp(errorReplyMessage).catch(e2 => console.error(`[SpinID: ${spinId || 'N/A'}] Failed to followUp on error:`, e2));
        });
      } else {
         // Should not happen if deferReply is used first.
        await interaction.reply(errorReplyMessage).catch(e => console.error(`[SpinID: ${spinId || 'N/A'}] Failed to send initial reply on error:`, e));
      }
    }
  },
};