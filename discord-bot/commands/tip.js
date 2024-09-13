const { SlashCommandBuilder } = require('@discordjs/builders');
const axios = require('axios');
const { findOrCreateDiscordUser } = require('../userUtils');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('tip')
    .setDescription('Tip another user some PAT!')
    .addUserOption(option => option
      .setName('recipient')
      .setDescription('The user you want to tip')
      .setRequired(true))
    .addIntegerOption(option => option
      .setName('amount')
      .setDescription('The amount of PAT you want to tip')
      .setRequired(true)),

  async execute(interaction) {
    const senderDiscordUser = interaction.user;
    const recipientDiscordUser = interaction.options.getUser('recipient');
    const amount = interaction.options.getInteger('amount');

    try {
      // Step 1: Ensure the sender exists or create a new user
      const sender = await findOrCreateDiscordUser(
        senderDiscordUser.id,
        senderDiscordUser.username,
        senderDiscordUser.displayAvatarURL()
      );

      // Step 2: Check if the recipient exists using the endpoint
      let recipient;
      try {
        const recipientResponse = await axios.get(
          `http://localhost:3000/api/users/discord/${recipientDiscordUser.id}`
        );
        recipient = recipientResponse.data.user;
      } catch (error) {
        if (error.response && error.response.status === 404) {
          // Handle recipient not found
          return interaction.reply({
            content: `User ${recipientDiscordUser.username} does not exist.`,
            ephemeral: true,
          });
        } else {
          // Handle other errors
          console.error(`Error fetching recipient ${recipientDiscordUser.username}:`, error.message);
          return interaction.reply({
            content: `There was an error retrieving the recipient's information.`,
            ephemeral: true,
          });
        }
      }

      // Step 3: Send tip using the existing /chattip endpoint
      try {
        const tipResponse = await axios.post(
          `http://localhost:3000/u/${recipient.username}/chattip`,
          {
            amount: amount,
            sender: sender.username,
            recipient: recipient.username,
            password: process.env.DISCORD_BOT_TOKEN,
          }
        );

        if (tipResponse.data.message === "Tip sent successfully.") {
          // Fetch updated balances for both sender and recipient
          const [senderBalanceResponse, recipientBalanceResponse] = await Promise.all([
            axios.get(`http://localhost:3000/api/u/${sender.username}/balance`),
            axios.get(`http://localhost:3000/api/u/${recipient.username}/balance`)
          ]);

          const senderBalance = senderBalanceResponse.data.balance;
          const recipientBalance = recipientBalanceResponse.data.balance;

          interaction.reply({
            content: `${senderDiscordUser.username} (PAT ${senderBalance}) tipped PAT ${amount} to ${recipientDiscordUser.username} (PAT ${recipientBalance}).`
          });
        } else {
          interaction.reply({
            content: `There was an issue with the tip.`,
            ephemeral: true,
          });
        }
      } catch (error) {
        if (error.response && error.response.status === 400 && error.response.data === "Insufficient balance") {
          const senderBalanceResponse = await axios.get(
            `http://localhost:3000/api/u/${sender.username}/balance`
          );
          const senderBalance = senderBalanceResponse.data.balance;
          return interaction.reply({
            content: `You do not have enough PAT to tip ${amount}. Your balance is PAT ${senderBalance}.`,
            ephemeral: true,
          });
        } else {
          console.error(`Error sending tip from ${sender.username} to ${recipient.username}:`, error.message);
          interaction.reply({
            content: `There was an error processing your tip.`,
            ephemeral: true,
          });
        }
      }
    } catch (error) {
      console.error(`Error processing tip from ${senderDiscordUser.username} to ${recipientDiscordUser.username}:`, error.message);
      interaction.reply({
        content: `There was an error processing your tip.`,
        ephemeral: true,
      });
    }
  }
};
