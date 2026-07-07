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

    if (message.author.id == '926267272501272636' && message.content.startsWith('!png')) {
        // "!png <sb>/<bb> <@hostId>" -> run PokerNow /new-game. Blinds/mention order-agnostic.
        const pngParts = message.content.trim().split(/\s+/);
        let blinds = null;
        let hostId = null;
        for (const p of pngParts.slice(1)) {
            if (/^\d+\/\d+$/.test(p)) blinds = p;
            const m = p.match(/^<@!?(\d+)>$/);
            if (m) hostId = m[1];
        }
        if (!blinds) blinds = '100/200';
        const [sb, bb] = blinds.split('/');
        console.log(`New game: sb=${sb} bb=${bb} host=${hostId}`);
        // /new-game [small blind] [big blind] — the resulting URL is caught + registered
        // by the PATV Discord bot's messageUpdate listener.
        message.channel.sendSlash('613156357239078913', 'new-game', sb, bb)
            .catch(err => console.error('new-game slash failed:', err && err.message));
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