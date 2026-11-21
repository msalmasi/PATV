const { SlashCommandBuilder } = require('@discordjs/builders');
const axios = require('axios');
const { findOrCreateDiscordUser } = require('../userUtils');
const EventSource = require('eventsource');
const { sseHeaders } = require('../backendAuth');   // 1.99acf: X-PATV-Key on the /events streams when PATV_KEY is set
const { errInfo } = require('../errinfo'); // 1.99aou: status + answer only - never a request's config or headers

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
        
        interaction.editReply(`${interaction.user} requested a spin!`);
        setupWagerListener(spinId, interaction);
        // Set up listeners for the wager and results
        
        await setupResultsListener(spinId, interaction, user);
      } else {
        throw new Error("Spin request failed.");
      }
    } catch (error) {
      console.error(`Error during spin for ${discordUser.username}:`, errInfo(error));
      // 1.99aou: the site's answer when there is one - a network error or a spin with no id has none (that threw here)
      const answer = error && error.response ? error.response.data : "please try again in a minute";
      interaction.editReply(`${interaction.user}, I can't do that right now: ${answer} 😵`);
    }
  },
};

// EVENT LISTENERS

async function setupResultsListener(spinId, interaction, user) {
  
  const resultsUrl = process.env.BACKEND_BASE_URL+`/events?type=results&identifier=${encodeURIComponent(spinId)}`;
  const eventSource1 = new EventSource(resultsUrl, sseHeaders(resultsUrl));

  // 1.99aou: the handler's body in a try - a failed balance lookup or follow-up is logged as errInfo and the stream closed,
  // never an unhandled rejection (that printed the whole AxiosError with the request's headers)
  eventSource1.onmessage = async function (event) {
    try {
      const result = JSON.parse(event.data);
      console.log("Spin result received:", result);

      const spinnerBalanceResponse = await axios.get(process.env.BACKEND_BASE_URL+`/api/u/${encodeURIComponent(user.username)}/balance`);
      const spinnerBalance = spinnerBalanceResponse.data.balance;

      if (result.jackpot) {
        if (result.grand) {
          await interaction.followUp(
            `🏆🏆🏆 ${interaction.user} hit the GRAND JACKPOT and won the ENTIRE pot: PAT ${result.result}!!!! (+${result.xp} XP, New Balance: PAT ${spinnerBalance})`
          );
        } else {
          await interaction.followUp(
            `🏆 ${interaction.user} hit the JACKPOT and won ${result.jackpotPct}% of the pot: PAT ${result.result}! (+${result.xp} XP, New Balance: PAT ${spinnerBalance})`
          );
        }
        eventSource1.close();
      } else {
        await interaction.followUp(
          `${interaction.user} won PAT ${result.result} and gained ${result.xp} XP. (New Balance: PAT ${spinnerBalance}).`
        );
        eventSource1.close();
      }
    } catch (error) {
      console.error("Spin result failed:", errInfo(error));
      eventSource1.close();
    }
  };

  eventSource1.onerror = async function (event) {
    console.error("EventSource failed:", event);
    eventSource1.close();
  };
}

async function setupWagerListener(spinId, interaction) {
    const spinUrl = process.env.BACKEND_BASE_URL+`/events?type=spin&identifier=${encodeURIComponent(spinId)}`;
    const eventSource = new EventSource(spinUrl, sseHeaders(spinUrl));

  eventSource.onmessage = async function (event) {   // 1.99aou: in a try, like the results handler
    try {
      const data = JSON.parse(event.data);
      console.log("Spin command received:", data);

      if (data.message.includes("public spinid") && data.spinId) {
        var spinnerUsername = data.message.split(" ")[4];
        console.log (spinnerUsername);
        const spinnerBalanceResponse = await axios.get(process.env.BACKEND_BASE_URL+`/api/u/${encodeURIComponent(spinnerUsername)}/balance`);
        const spinnerBalance = spinnerBalanceResponse.data.balance;
        await interaction.editReply(
          `${interaction.user} is spinning the wheel for PAT 5000, good luck! (New Balance: PAT ${spinnerBalance}).`
        );
      }
    } catch (error) {
      console.error("Spin wager update failed:", errInfo(error));
    }
    eventSource.close();

  };

  eventSource.onerror = async function (event) {
    console.error("Wager EventSource failed:", event);
    eventSource.close();
  };
}
