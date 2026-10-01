const { SlashCommandBuilder } = require('@discordjs/builders');
const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const axios = require('axios');
const { findOrCreateDiscordUser } = require('../userUtils'); // Reuse this to get user info

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('View available items in the shop and purchase'),

  async execute(interaction) {
    try {
      // Fetch the list of prizes from the backend API
      const response = await axios.get(process.env.BACKEND_BASE_URL+'/api/prizes');
      const prizes = response.data;

      if (prizes.length === 0) {
        return interaction.reply({ content: 'The shop is currently empty.', ephemeral: true });
      }

      // Create the select menu options from the prizes
      const options = prizes.map((item) => ({
        label: `${item.prize} (PAT ${item.cost})`,
        value: item.prizeId // We'll use prizeId to handle purchase
      }));

      // Create a select menu component with the available items
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('select_prize')
        .setPlaceholder('Choose an item to buy')
        .addOptions(options);

      // Send the initial reply with the select menu
      const row = new ActionRowBuilder().addComponents(selectMenu);
      await interaction.reply({ content: 'Here are the available items in the shop:', components: [row], ephemeral: true });

    } catch (error) {
      console.error('Error fetching shop items:', error);
      interaction.reply({ content: 'There was an error fetching the shop items.', ephemeral: true });
    }
  },

  // Handle the select menu interaction
  async handleSelectMenu(interaction) {
    const selectedPrizeId = interaction.values[0]; // Get the selected prizeId from the menu
    const selectedPrizeName = await getPrizeDetails(selectedPrizeId);
    const discordId = interaction.user.id;
    const displayName = interaction.user.username;
    const profileImage = interaction.user.displayAvatarURL();
    let user = '';

    try {
      // Ensure the user exists or is created
      user = await findOrCreateDiscordUser(discordId, displayName, profileImage);

      // Attempt to purchase the selected item via the backend API
      const response = await axios.post(process.env.BACKEND_BASE_URL+'/chatshop', {
        product: selectedPrizeId,
        username: user.username,
        userId: user.userId,
        password: process.env.DISCORD_BOT_TOKEN, // Secure this
      });

      if (response.data && response.data.success) {
        // Purchase successful. Grant the role a role prize stands for. (Each check used to end in a
        // stray `;` - `if (...);` - so its block ran for EVERY purchase and gave all three roles.)
        const ROLE_FOR_PRIZE = {
          '147ce895-37c2-4c43-98cc-9f7045de0cf3': 'scout',
          'c0e57e08-6696-4c51-94ec-485f13a68cd8': 'curator',
          '491cde2e-097e-4c2a-a351-ce441137ba38': 'high roller',
        };
        const roleName = ROLE_FOR_PRIZE[selectedPrizeId];
        if (roleName) {
          const role = interaction.guild.roles.cache.find(r => r.name === roleName);
          if (role) await interaction.member.roles.add(role);
        }
        const balanceResponse = await axios.get(process.env.BACKEND_BASE_URL+`/api/u/${user.username}/balance`);
        const balance = balanceResponse.data.balance;
        interaction.guild.channels.cache.get('1245478269294346320').send(`${interaction.user} bought ${selectedPrizeName.prizeName}`)
        await interaction.update({ content: `You successfully purchased ${selectedPrizeName.prizeName} (PAT ${selectedPrizeName.prizeCost})! You have PAT ${balance}. Please wait up to 24 hours for activation.`, components: [], ephemeral: true });
      } else {
        // Handle errors like insufficient balance
        await interaction.update({ content: `Purchase failed: ${response.data.message}`, components: [], ephemeral: true });
      }

    } catch (error) {
      if (error.response && error.response.status === 400 && error.response.data.message === "Insufficient coins") {
        // Handle insufficient balance
        const balanceResponse = await axios.get(process.env.BACKEND_BASE_URL+`/api/u/${user.username}/balance`);
        const balance = balanceResponse.data.balance;
        await interaction.update({ content: `You have insufficient funds to buy ${selectedPrizeName.prizeName} (PAT ${selectedPrizeName.prizeCost}). You have PAT ${balance}.`, components: [], ephemeral: true });
      } else if (error.response && error.response.data && error.response.data.message) {
        // The backend's own reason: out of stock, already have that role, short by N PAT, ...
        await interaction.update({ content: `Purchase failed: ${error.response.data.message}`, components: [], ephemeral: true });
      } else {
        console.error('Error during purchase:', error);
        await interaction.update({ content: 'There was an error processing your purchase.', components: [], ephemeral: true });
      }
    }
  }
};

// Function to get the prize details (name and cost) by prizeId
async function getPrizeDetails(prizeId) {
    try {
      // Fetch the prize details using the prizeId from the backend API
      const response = await axios.get(process.env.BACKEND_BASE_URL+`/api/prizes`);
  
      const prizes = response.data;
  
      // Find the prize with the matching prizeId
      const prize = prizes.find((item) => item.prizeId === prizeId);
  
      if (prize) {
        return {
          prizeName: prize.prize,
          prizeCost: prize.cost,
        };
      } else {
        throw new Error(`Prize with ID ${prizeId} not found.`);
      }
    } catch (error) {
      console.error(`Error fetching prize details for prizeId ${prizeId}:`, error);
      throw error; // Rethrow the error to handle it in the calling function
    }
  }
