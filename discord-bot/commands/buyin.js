const { SlashCommandBuilder } = require('@discordjs/builders');
const axios = require('axios');
const { findOrCreateDiscordUser } = require('../userUtils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('buyin')
    .setDescription('Buy poker chips with PAT')
    .addIntegerOption(option => 
        option.setName('amount')
        .setDescription('Amount of chips to buy')
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

      // Step 2: Call the backend API to perform the buy-in
      const response = await axios.post('http://localhost:3000/api/poker/cashier', {
        userId: user.userId, // Use the backend userId
        amount: amount,
        action: 'buyin'
      });

      // Step 3: Send a message to the poker game system
      interaction.guild.channels.cache.get('1243767733762392134')
        .send(`!pac ${interaction.user} ${amount}`);

      // Step 4: Inform the user
      interaction.reply({ content: `${interaction.user}, done! You bought ${amount} poker chips successfully.`, ephemeral: true });

    } catch (error) {
      if (error.response && error.response.status === 400 && error.response.data === 'Insufficient balance') {
        // Fetch user's current balance and inform them of insufficient funds
        const balanceResponse = await axios.get(`http://localhost:3000/api/u/${user.username}/balance`);
        const balance = balanceResponse.data.balance;
        interaction.reply({ content: `${interaction.user} (PAT ${balance}), you have insufficient funds to buy ${amount} poker chips.`, ephemeral: true });
      } else {
        console.error('Error during buy-in:', error);
        interaction.reply({ content: 'An error occurred during the buy-in process.', ephemeral: true });
      }
    }
  }
};