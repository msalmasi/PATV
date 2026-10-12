const { SlashCommandBuilder } = require('@discordjs/builders');
const axios = require('axios');
const { findOrCreateDiscordUser } = require('../userUtils'); // Assuming this is where the utility is stored

module.exports = {
    data: new SlashCommandBuilder()
      .setName('cashout')
      .setDescription('Swap poker chips back to PAT')
      .addIntegerOption(option => 
          option.setName('amount')
          .setDescription('Amount of chips to swap back to PAT')
          .setRequired(true)),
  
    async execute(interaction) {
      const amount = interaction.options.getInteger('amount');
      const discordId = interaction.user.id;
      const displayName = interaction.user.username;
      const profileImage = interaction.user.displayAvatarURL();
  
      if (amount <= 0) {
        return interaction.reply({ content: 'Amount must be greater than 0.', ephemeral: true });
      }
  
      try {
        // Step 1: Find or create Discord user
        const user = await findOrCreateDiscordUser(discordId, displayName, profileImage);
  
        // Step 2: Send a message to the poker game system
        interaction.guild.channels.cache.get('1243767733762392134')
          .send(`!prc ${interaction.user} ${amount}`);
  
        // Step 3: Inform the user
        interaction.reply({ content: `${interaction.user} asked to swap ${amount} poker chips back to PAT!`, ephemeral: true });
  
      } catch (error) {
        console.error('Error during cashout:', error);
        interaction.reply({ content: 'Something went wrong swapping your chips back to PAT.', ephemeral: true });
      }
    }
  };