const { SlashCommandBuilder } = require('@discordjs/builders');
const axios = require('axios');
const { findOrCreateDiscordUser } = require('../userUtils'); // Ensure this path is correct
const EventSource = require('eventsource');

// Wrapper for wager event listener
async function handleWagerEvent(spinId, interaction) {
  return new Promise((resolve, reject) => {
    const eventSourceUrl = `${process.env.BACKEND_BASE_URL}/events?type=spin&identifier=${spinId}`;
    console.log(`[SpinID: ${spinId}][WAGER] Setting up EventSource to: ${eventSourceUrl}`);
    const eventSource = new EventSource(eventSourceUrl);
    let processed = false;

    const timeoutDuration = 15000; // 15 seconds
    const timeoutId = setTimeout(() => {
      if (processed) return;
      processed = true;
      console.warn(`[SpinID: ${spinId}][WAGER] Listener timed out after ${timeoutDuration}ms.`);
      eventSource.close();
      reject(new Error('Wager event listener timed out.'));
    }, timeoutDuration);

    eventSource.onmessage = async function (event) {
      if (processed) return;
      
      // CRITICAL LOGGING: START
      console.log(`[SpinID: ${spinId}][WAGER] RAW EVENT RECEIVED: type=${event.type}, data=${event.data}`);
      let data;
      try {
        data = JSON.parse(event.data);
        console.log(`[SpinID: ${spinId}][WAGER] PARSED DATA:`, data);
      } catch (parseError) {
        console.error(`[SpinID: ${spinId}][WAGER] JSON PARSE ERROR:`, parseError, `RAW DATA: ${event.data}`);
        // Don't close or reject yet, might be an irrelevant message. Or, if all messages must be JSON:
        // eventSource.close();
        // reject(new Error('Failed to parse wager event data.'));
        return; // Skip this message
      }
      // Log conditions
      console.log(`[SpinID: ${spinId}][WAGER] Checking condition: data.message? ${!!data.message}, includes "public spinid"? ${data.message ? data.message.includes("public spinid") : 'N/A'}, data.spinId? ${data.spinId}, matches spinId? ${data.spinId === spinId}`);
      // CRITICAL LOGGING: END

      if (data.message && data.message.includes("public spinid") && data.spinId === spinId) {
        processed = true;
        clearTimeout(timeoutId);
        try {
          const messageParts = data.message.split(" ");
          let spinnerUsername = interaction.user.username; 
          if (messageParts.length > 4 && messageParts[3].toLowerCase() === "spinid") { // Simplified assumption
             spinnerUsername = messageParts[4];
             console.log(`[SpinID: ${spinId}][WAGER] Extracted spinnerUsername: ${spinnerUsername}`);
          } else {
             console.warn(`[SpinID: ${spinId}][WAGER] Could not reliably extract spinnerUsername from: "${data.message}". Defaulting to ${interaction.user.username}.`);
          }

          const spinnerBalanceResponse = await axios.get(`${process.env.BACKEND_BASE_URL}/api/u/${spinnerUsername}/balance`);
          const spinnerBalance = spinnerBalanceResponse.data.balance;

          await interaction.editReply( // This is the targeted edit
            `Spinning the wheel for PAT 5000, good luck! Your current balance is PAT ${spinnerBalance}.`
          );
          console.log(`[SpinID: ${spinId}][WAGER] Message successfully updated via editReply.`);
          eventSource.close();
          resolve();
        } catch (error) {
          console.error(`[SpinID: ${spinId}][WAGER] Error processing event or editing reply:`, error);
          eventSource.close();
          reject(error);
        }
      } else {
        console.log(`[SpinID: ${spinId}][WAGER] Received message did not meet conditions. Waiting for another or timeout.`);
      }
    };

    eventSource.onerror = function (errEvent) {
      if (processed) return;
      processed = true;
      clearTimeout(timeoutId);
      // An error event can be a simple { type: 'error' } or have more details
      const errorMessage = errEvent.message || (errEvent.type ? `EventSource error type: ${errEvent.type}` : 'Unknown EventSource error');
      console.error(`[SpinID: ${spinId}][WAGER] EventSource error:`, errorMessage, errEvent);
      eventSource.close();
      reject(new Error(`Wager EventSource error: ${errorMessage}`));
    };
  });
}

// Wrapper for results event listener
async function setupResultsListener(spinId, interaction, user) {
  return new Promise((resolve, reject) => {
    const eventSourceUrl = `${process.env.BACKEND_BASE_URL}/events?type=results&identifier=${spinId}`;
    console.log(`[SpinID: ${spinId}][RESULTS] Setting up EventSource to: ${eventSourceUrl}`);
    const eventSource = new EventSource(eventSourceUrl);
    let processed = false;

    const timeoutDuration = 30000; // 30 seconds
    const timeoutId = setTimeout(() => {
      if (processed) return;
      processed = true;
      console.warn(`[SpinID: ${spinId}][RESULTS] Listener timed out after ${timeoutDuration}ms.`);
      eventSource.close();
      interaction.followUp(`Sorry ${interaction.user.username}, we couldn't get your spin results for spin ${spinId} in time. Please check your balance later.`).catch(e => console.error(`[SpinID: ${spinId}][RESULTS] Error sending timeout followup:`, e));
      reject(new Error('Results event listener timed out.'));
    }, timeoutDuration);

    eventSource.onmessage = async function (event) {
      if (processed) return;

      // CRITICAL LOGGING: START
      console.log(`[SpinID: ${spinId}][RESULTS] RAW EVENT RECEIVED: type=${event.type}, data=${event.data}`);
      let result;
      try {
        result = JSON.parse(event.data);
        console.log(`[SpinID: ${spinId}][RESULTS] PARSED DATA:`, result);
      } catch (parseError) {
        console.error(`[SpinID: ${spinId}][RESULTS] JSON PARSE ERROR:`, parseError, `RAW DATA: ${event.data}`);
        return; // Skip this message
      }
      // CRITICAL LOGGING: END
      
      // Assuming any message on this stream is the result we want
      processed = true; 
      clearTimeout(timeoutId);

      try {
        const spinnerBalanceResponse = await axios.get(`${process.env.BACKEND_BASE_URL}/api/u/${user.username}/balance`);
        const spinnerBalance = spinnerBalanceResponse.data.balance;

        if (result.result > 1000000) {
          await interaction.followUp(
            `🎉 PAT ${result.result} JACKPOT for ${interaction.user}!!!! 🥳 (Spin ID: ${spinId}, New Balance: PAT ${spinnerBalance})`
          );
        } else {
          await interaction.followUp(
            `You won PAT ${result.result} and gained ${result.xp || 0} XP, ${interaction.user}. (Spin ID: ${spinId}, New Balance: PAT ${spinnerBalance})`
          );
        }
        console.log(`[SpinID: ${spinId}][RESULTS] FollowUp sent successfully.`);
        eventSource.close();
        resolve();
      } catch (error) {
        console.error(`[SpinID: ${spinId}][RESULTS] Error fetching balance or sending followup:`, error);
        await interaction.followUp(
          `Got your spin result (Won PAT ${result.result} for spin ${spinId}), but there was an issue fetching your new balance, ${interaction.user}.`
        ).catch(e => console.error(`[SpinID: ${spinId}][RESULTS] Error sending partial results followup:`, e));
        eventSource.close();
        reject(error); // Reject with the error from processing
      }
    };

    eventSource.onerror = function (errEvent) {
      if (processed) return;
      processed = true;
      clearTimeout(timeoutId);
      const errorMessage = errEvent.message || (errEvent.type ? `EventSource error type: ${errEvent.type}` : 'Unknown EventSource error');
      console.error(`[SpinID: ${spinId}][RESULTS] EventSource error:`, errorMessage, errEvent);
      eventSource.close();
      interaction.followUp(`Sorry ${interaction.user.username}, there was an error getting your spin results for spin ${spinId}.`).catch(e => console.error(`[SpinID: ${spinId}][RESULTS] Error sending results error followup:`, e));
      reject(new Error(`Results EventSource error: ${errorMessage}`));
    };
  });
}


module.exports = {
  data: new SlashCommandBuilder()
    .setName('spin')
    .setDescription('Spin the wheel and try your luck!'),

  async execute(interaction) {
    const discordUser = interaction.user;
    let spinId = null; 

    try {
      await interaction.deferReply();

      const user = await findOrCreateDiscordUser(
        discordUser.id,
        discordUser.username,
        discordUser.displayAvatarURL()
      );

      console.log(`Attempting spin for ${user.username} (Discord ID: ${discordUser.id})`);
      const url = `${process.env.BACKEND_BASE_URL}/api/g/wheel/chatspin`;

      const spinResponse = await axios.post(url, {
        username: user.username, 
        password: process.env.DISCORD_BOT_TOKEN, 
      });

      if (spinResponse.data && spinResponse.data.spinId) {
        spinId = spinResponse.data.spinId; 
        console.log(`[SpinID: ${spinId}] Spin request successful.`);
        await interaction.editReply(`Got your spin request, ${discordUser.username}! Preparing the wheel (Spin ID: ${spinId})... ⚙️`);
        console.log(`[SpinID: ${spinId}] Initial reply sent.`);

        // Launch wager event handler (don't await its full completion here)
        handleWagerEvent(spinId, interaction)
          .then(() => {
            console.log(`[SpinID: ${spinId}][WAGER] Event processing chain completed successfully.`);
          })
          .catch((wagerError) => {
            console.error(`[SpinID: ${spinId}][WAGER] Event handling chain failed: ${wagerError.message}`);
            // Wager listener already tries to inform user on timeout/error or handles its own logic.
            // If handleWagerEvent doesn't send a message on error, you might add one here:
            // interaction.followUp(`There was an issue confirming wager details for spin ${spinId}.`).catch(e => {});
          });

        // Launch results event handler concurrently
        setupResultsListener(spinId, interaction, user)
          .then(() => {
            console.log(`[SpinID: ${spinId}][RESULTS] Event processing chain completed successfully.`);
          })
          .catch((resultsError) => {
            console.error(`[SpinID: ${spinId}][RESULTS] Event handling chain failed: ${resultsError.message}`);
            // setupResultsListener already sends followups on its errors/timeouts
          });
        
        console.log(`[SpinID: ${spinId}] Both wager and results listeners have been initiated.`);

      } else {
        console.error(`Spin request failed or spinId missing. Response:`, spinResponse.data);
        await interaction.editReply(
          `Sorry ${discordUser.username}, your spin request failed (backend didn't provide a spin ID). 😥`
        );
      }
    } catch (error) {
      const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
      console.error(`[SpinID: ${spinId || 'N/A'}] Error during spin command for ${discordUser.username}:`, errorMessage, error.stack);
      const replyMessage = `Sorry ${discordUser.username}, something went wrong while spinning the wheel. 😵`;
      if (!interaction.replied && !interaction.deferred) {
        // This case should be rare if deferReply is the first action.
        await interaction.reply(replyMessage).catch(e => console.error(`[SpinID: ${spinId || 'N/A'}] Error sending initial reply in main catch:`, e));
      } else if (!interaction.replied) {
        // Deferred but not yet replied (e.g. error before first editReply)
        await interaction.editReply(replyMessage).catch(e => console.error(`[SpinID: ${spinId || 'N/A'}] Error editing deferred (but not yet replied) reply in main catch:`, e));
      } else {
        // Already replied (e.g. initial editReply worked, error later)
        // Try to followUp, as editing might be locked or less appropriate.
        await interaction.followUp(replyMessage).catch(e => console.error(`[SpinID: ${spinId || 'N/A'}] Error sending followup in main catch:`, e));
      }
    }
  },
};