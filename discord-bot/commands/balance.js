const { SlashCommandBuilder } = require('@discordjs/builders');
const axios = require('axios');
const { findOrCreateDiscordUser } = require('../userUtils'); // Helper function to find or create user

module.exports = {
  data: new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your PAT balance'),
  
  async execute(interaction) {
    const discordUser = interaction.user; // Get user info from the interaction

    try {
      // Step 1: Ensure the user exists (either found or created)
      const user = await findOrCreateDiscordUser(
        discordUser.id,
        discordUser.username,
        discordUser.avatar
      );
      
      // Step 2: Fetch the user's balance using the API endpoint
      const balanceResponse = await axios.get(
        `https://publicaccess.tv/api/u/${user.username}/balance`
      );

      if (
        balanceResponse.data &&
        balanceResponse.data.balance !== undefined &&
        balanceResponse.data.balance !== 0
      ) {
        const balance = balanceResponse.data.balance;
        await interaction.reply(
          `Howdy @${discordUser.username}, you currently have PAT ${balance}.`
        );
      } else if (
        balanceResponse.data.balance == null ||
        balanceResponse.data.balance == 0
      ) {
        await interaction.reply(
          `Howdy @${discordUser.username}. You have no PAT. Sign up at https://publicaccess.tv to learn how to get some.`
        );
      } else {
        throw new Error('Balance data is not available');
      }
    } catch (error) {
      console.error(`Error fetching balance for ${discordUser.username}:`, error.message);
      await interaction.reply(
        `@${discordUser.username}, there was an error fetching your balance.`
      );
    }
  },
};
