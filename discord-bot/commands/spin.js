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

async function setupWagerListener(spinId, interaction) {
    const eventSource = new EventSource(
        process.env.BACKEND_BASE_URL+`/events?type=spin&identifier=${spinId}`
      );

  eventSource.onmessage = async function (event) {
    const data = JSON.parse(event.data);
    console.log("Spin command received:", data);

    if (data.message.includes("public spinid") && data.spinId) {
      var spinnerUsername = data.message.split(" ")[4];
      console.log (spinnerUsername);
      const spinnerBalanceResponse = await axios.get(process.env.BACKEND_BASE_URL+`/api/u/${spinnerUsername}/balance`);
      const spinnerBalance = spinnerBalanceResponse.data.balance;
      interaction.editReply(
        `Spinning the wheel for PAT 5000, good luck! Your current balance is PAT ${spinnerBalance}.`
      );
    }
    eventSource.close();
  };

  eventSource.onerror = function (event) {
    console.error("EventSource failed:", event);
    eventSource.close();
  };
}
