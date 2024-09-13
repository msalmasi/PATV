const { Client } = require('discord.js-selfbot-v13');
const client = new Client();
const { token } = require("./config.json");

client.on('ready', async () => {
  console.log(`${client.user.username} is ready!`);
  })

client.on("messageCreate", message => {
  // console.log(message)
    if (message.author.id == '926267272501272636' && message.content.startsWith('!pac')) {
      // Split the message into parts
        const parts = message.content.split(' ');

        // Ensure the command format is correct
        if (parts.length === 3) {
            const mention = parts[1];
            const number = parts[2];

            // Extract user ID from mention
            const userId = mention.match(/^<@!?(\d+)>$/);
            if (userId) {
                console.log('User ID:', userId[1]);
                console.log('Number:', number);
                message.channel.sendSlash('613156357239078913', 'admin-chips add', userId[1], number);
            } else {
                console.log('Invalid mention format');
            }

        } else {
            console.log('Invalid command format');
        }
    }

    if (message.author.id == '926267272501272636' && message.content.startsWith('!prc')) {
      // Split the message into parts
        const parts = message.content.split(' ');

        // Ensure the command format is correct
        if (parts.length === 3) {
            const mention = parts[1];
            const number = parts[2];

            // Extract user ID from mention
            const userId = mention.match(/^<@!?(\d+)>$/);
            if (userId) {
                console.log('User ID:', userId[1]);
                console.log('Number:', number);
                message.channel.sendSlash('613156357239078913', 'admin-chips remove', userId[1], number);
            } else {
                console.log('Invalid mention format');
            }

        } else {
            console.log('Invalid command format');
        }
    }
});

client.login(token);