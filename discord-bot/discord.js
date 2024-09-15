// Import dependencies
const fs = require("fs");
const {
  Client,
  Collection,
  Partials,
  Events,
  GatewayIntentBits,
} = require("discord.js");
const { token } = require("./config.json");
const axios = require("axios");
require("dotenv").config();
const { findOrCreateDiscordUser, findUserBalance } = require("./userUtils"); // Helper function to find or create user

// Create a new Discord client instance
const client = new Client({
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildScheduledEvents,
  ],
});

// Load commands from the commands directory
client.commands = new Collection();
const commandFiles = fs
  .readdirSync("./commands")
  .filter((file) => file.endsWith(".js"));

for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  client.commands.set(command.data.name, command);
}

// Load event handlers from the events directory
const eventFiles = fs
  .readdirSync("./events")
  .filter((file) => file.endsWith(".js"));

for (const file of eventFiles) {
  const event = require(`./events/${file}`);
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
}

let currentRaffleParticipants = new Set();
let raffleTimeout;

// Function to start a new raffle
function startRaffle(channelId) {
  console.log("Raffle started!");

  // Clear any existing participants
  currentRaffleParticipants.clear();

  // Determine a random duration between 15 and 60 minutes
  const raffleDurationMinutes = Math.floor(Math.random() * (60 - 15 + 1)) + 15;
  const raffleDurationMs = raffleDurationMinutes * 60 * 1000; // Convert to milliseconds

  console.log(`Raffle will end in ${raffleDurationMinutes} minutes`);

  // Schedule the end of the raffle
  raffleTimeout = setTimeout(() => {
    endRaffle(channelId, raffleDurationMinutes);
  }, raffleDurationMs);
}

// Shop Command Enhancement
client.on("interactionCreate", async (interaction) => {
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "select_prize") {
      const shopCommand = require("./commands/shop"); // Adjust the path as needed
      await shopCommand.handleSelectMenu(interaction);
    }
  }
});

// Function to handle chat messages (enter users into the raffle)
async function onChatMessage(message) {
  const discordId = message.author.id; // Discord user ID
  const discordUsername = message.author.username;
  const profileImage = message.author.avatarURL(); // Discord avatar URL

  if (!discordId) return;

  try {
    // Ensure that the user exists in your backend using findOrCreateDiscordUser
    const user = await findOrCreateDiscordUser(
      discordId,
      discordUsername,
      profileImage
    );

    if (user && user.userId) {
      // Check if the user is already in the raffle
      if (!currentRaffleParticipants.has(user.discordId)) {
        // Add the backend userId to the raffle participants
        currentRaffleParticipants.add(user.discordId);
        console.log(`User ${user.username} added to the raffle.`);
      } else {
        console.log(`User ${user.username} is already in the raffle.`);
      }
    }
  } catch (error) {
    console.error("Error adding user to raffle:", error.message);
  }
}

// Function to end the raffle and select a winner
async function endRaffle(channelId, raffleDurationMinutes) {
  const channel = client.channels.cache.get(channelId);

  if (currentRaffleParticipants.size === 0) {
    console.log("No participants in the raffle.");
    startRaffle(channelId); // Start a new raffle
    return;
  }

  // Convert Set to an array and select a random user
  const participantsArray = Array.from(currentRaffleParticipants);
  const randomIndex = Math.floor(Math.random() * participantsArray.length);
  const winnerId = participantsArray[randomIndex];
  const winnerBalance = await findUserBalance(winnerId);
  let discordUsername = "";
  let userId = "";

  // Find the discordUsername of the winnerId from the backend
  try {
    const userResponse = await axios.get(
      process.env.BACKEND_BASE_URL+`/api/users/discord/${winnerId}`
    );
    if (userResponse.data && userResponse.data.user) {
      discordUsername = userResponse.data.user.discordUsername;
      userId = userResponse.data.user.userId;
    }
  } catch (error) {
    console.error(`Error fetching winner info for ${winnerId}:`, error.message);
    return;
  }

  // Determine a random prize between 100 and 500 multiplied by the raffle duration
  const randomPrize =
    (Math.floor(Math.random() * 401) + 100) * raffleDurationMinutes;

  console.log(
    `User with ID ${winnerId} won the raffle with a prize of ${randomPrize} points!`
  );

  // Send the result to the backend
  try {
    await axios.post(process.env.BACKEND_BASE_URL+`/api/bonus/chatwinner`, {
      userId: userId,
      type: "discord-raffle",
      amount: randomPrize,
      password: process.env.DISCORD_BOT_TOKEN,
    });

    console.log("Raffle winner logged in backend.");
    let guild = client.guilds.cache.get("913269267691094026");
    guild.members.fetch();
    const member = guild.members.cache.find((m) => m.user.id === winnerId);
    channel.send(
      `🎉 ${member} (PAT ${winnerBalance}) won the random chat raffle with a prize of PAT ${randomPrize}! 🎉`
    );
  } catch (error) {
    console.error("Failed to log raffle winner:", error);
  }

  // Start a new raffle
  startRaffle(channelId);
}

// Initialization when the bot starts
function initializeBot() {
  const raffleChannelId = "1192942297491447808"; // Replace with your actual channel ID
  startRaffle(raffleChannelId);
}

// Discord event listener for messages
client.on("messageCreate", (message) => {
  if (!message.author.bot) {
    // Add users to the raffle for every message they send
    onChatMessage(message);
  }

  if (
    message.author.id == "926267272501272636" ||
    message.author.id == "613156357239078913" ||
    message.author.id == "806684487417069578" ||
    message.author.id == "1129973747542130779" ||
    message.author.id == "1129968855909937232" ||
    message.author.id == "1241452261595414564" ||
    message.author.id == "558996910581612545" ||
    message.content.startsWith("!") ||
    message.guild.id != "913269267691094026" ||
    message.author.id == "934679177762832414" ||
    message.author.id == "568592114590547979" ||
    message.author.id == "1130228791453692036" ||
    message.author.id == "568592114590547979"
  ) {
    return;
  }

  // Checks if the message says "gm"
  if (message.content === "gm") {
    // Say gm back
    message.channel.send("gm");
  }
  // ban me
  if (message.content === "BAN ME") {
    // Sending custom message to the channel
    message.channel.send("ok");
    message.member.timeout(5, `1 Minute Timeout`);
  }
  // make the bot leave
  if (
    message.author.id == "150767175504887808" &&
    message.content.includes("Rombotleave")
  ) {
    // Get the guild ID
    var targetGuild = message.content.split(" ")[1];
    if (!targetGuild)
      // targetGuild is undefined if an ID was not supplied
      return message.reply("You must supply a Guild ID");

    if (message.author.id == "926267272501272636")
      // Don't listen to self.
      return;
    client.guilds.cache
      .get(targetGuild) // Grab the guild
      .leave() // Leave
      .then((g) => console.log(`I left ${g}`)) // Give confirmation after leaving
      .catch(console.error);
  }
  if (
    message.author.id == "568592114590547979" &&
    message.content.includes("advanced to") &&
    message.guild.id == "913269267691094026"
  ) {
    const levelBonus = extractLevel(message.content) * 10000;
    const levelXpBonus = extractLevel(message.content)^2 * 1000;
    const winnerId = message.mentions.members.first().id;
    const channel = message.channel;
    addLevelUpBonus(levelBonus, winnerId, channel);
    addLevelUpXpBonus(levelXpBonus, winnerId, channel);
  } else {
    return;
  }
});


client.on("messageUpdate", (oldMessage, newMessage) => {
  if (
    // Announces a poker game started by the Poker Now Bot
    newMessage.member.user.id == "613156357239078913" &&
    oldMessage.content.includes("URL of your new") &&
    newMessage.guild.id == "913269267691094026"
  ) {
    newMessage.channel.send(
      `<@&${"1192959473984212992"}> ${newMessage.mentions.members.first()} is starting a poker game!`
    );
  }
  // Processes cashout commands
  if (
    newMessage.member.displayName == "Poker Now Bot" &&
    newMessage.content.includes("removed") &&
    newMessage.guild.id == "913269267691094026"
  ) {
    console.log(newMessage.mentions.members.last().id);
    const discordId = newMessage.mentions.members.last().id;
    const discordUsername = newMessage.mentions.members.last();
    const pokerMessage = newMessage.content;
    const splitMessage = pokerMessage.split(" ");
    const amount = splitMessage[4];
    processCashout(discordId, amount, discordUsername);
  } 
  if (
    newMessage.member.displayName == "Poker Now Bot" &&
    newMessage.content.includes("user only has") &&
    newMessage.guild.id == "913269267691094026"
  ) {
    client.channels.cache.get('1192942161747001344').send(`Last poker cash-out request failed. Not enough chips.`);
  }else {
    return;
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
    if (reaction.partial) { //this whole section just checks if the reaction is partial
       try {
          await reaction.fetch(); //fetches reaction because not every reaction is stored in the cache
       } catch (error) {
          console.error('Fetching message failed: ', error);
          return;
       }
    }
    if (!user.bot) {
             if (reaction.emoji.id === '1243680971497144422') { //if the user reacted with the right emoji
 
 console.log("match detected");
      client.channels.cache.get(reaction.message.channelId).send("yes!!!")
 
         }
         else {
             console.log("match not detected");
             return;
         }
    }
 })

// Listen for the messageReactionAdd event
client.on('messageReactionAdd', async (reaction, user) => {

    // Emoji and message ID that triggers the badge award
const TARGET_MESSAGE_ID = '1245794448496132279'; // Replace with the actual message ID
const TARGET_EMOJI = 'pepecoin'; // The specific emoji for awarding the badge
const DISCORD_DEGEN_BADGE_ID = 'discord-degen'; // The badgeId for "discord-degen"
  // Ignore bot reactions
  if (user.bot) return;

  // Check if the reaction is on the target message and with the correct emoji
  if (reaction.message.id === TARGET_MESSAGE_ID && reaction.emoji.name === TARGET_EMOJI) {
    try {
      // Find or create the Discord user in the backend
      const discordId = user.id;
      const displayName = user.username;
      const avatar = user.displayAvatarURL();

      const discordUser = await findOrCreateDiscordUser(discordId, displayName, avatar);
      const bonus = 50000;


        // Call the API to award the "discord-degen" badge
        const response = await axios.post(process.env.BACKEND_BASE_URL+'/api/award-badge', {
          userId: discordUser.userId,
          badgeId: DISCORD_DEGEN_BADGE_ID,
          password: process.env.DISCORD_BOT_TOKEN, // Authenticate the request
        });
        if (response.data.success == true) {
            console.log(response.data);
            const winnerBalance = await findUserBalance(discordId);
            // Send the result to the backend
              try {
              await axios.post(process.env.BACKEND_BASE_URL+`/api/bonus/chatwinner`, {
                  userId: discordUser.userId,
                  type: "discord-casino",
                  amount: bonus,
                  password: process.env.DISCORD_BOT_TOKEN,
              });
             // Notify the user
             client.channels.cache.get(`1192942297491447808`).send(`⭐ Welcome to the casino ${user}! You've been given PAT ${bonus} as a new user bonus 🎁!!! See your balance and manage your account on https://publicaccess.tv ⭐`);
 
              console.log("Discord bonus logged in backend.");
              } catch (error) {
              console.error("Failed to log bonus winner:", error);
              }
      
      } else {
        console.error('Failed to award badge:', response.data.message);
      }
    } catch (error) {
      console.error('Error awarding badge:', error);
      user.send(`Sorry, there was an error awarding the discord degen badge.`);
    }
  }
});

async function processCashout(discordId, amount, discordUsername) {
    const user = await findOrCreateDiscordUser(discordId)
    const balance = await findUserBalance(discordId);
        // Call the backend API to perform the cash-out
        try {
        const response = await axios.post(process.env.BACKEND_BASE_URL+'/api/poker/cashier', {
            userId: user.userId, // Use the backend userId
            amount: amount,
            action: 'cashout'
          });
          if (response && response.data.message) {
            client.channels.cache.get('1192942161747001344').send(`${discordUsername} your cashout of ${amount} poker chips was successful. You now have PAT ${balance}.`);
          }
        }
        catch (error) {
          console.error(`Error fetching info for ${discordId}:`, error.message);
          return;
        }
      
        console.log(
          `User with ID ${discordId} cashed out ${amount} chips!`
        );
}

async function addLevelUpBonus(levelBonus, winnerId, channel) {
  const winnerBalance = await findUserBalance(winnerId);

  // Find the discordUsername of the winnerId from the backend
  try {
    const userResponse = await axios.get(
      process.env.BACKEND_BASE_URL+`/api/users/discord/${winnerId}`
    );
    if (userResponse.data && userResponse.data.user) {
      discordUsername = userResponse.data.user.discordUsername;
      userId = userResponse.data.user.userId;
    }
  } catch (error) {
    console.error(`Error fetching winner info for ${winnerId}:`, error.message);
    return;
  }

  console.log(
    `User with ID ${winnerId} won a level up bonus of ${levelBonus}!`
  );

  // Send the result to the backend
  try {
    await axios.post(process.env.BACKEND_BASE_URL+`/api/bonus/chatwinner`, {
      userId: userId,
      type: "discord-levelup",
      amount: levelBonus,
      password: process.env.DISCORD_BOT_TOKEN,
    });

    console.log("Level up winner logged in backend.");
    let guild = client.guilds.cache.get("913269267691094026");
    guild.members.fetch();
    const member = guild.members.cache.find((m) => m.user.id === winnerId);
    channel.send(
      `🎉 ${member} (PAT ${winnerBalance}) received a PAT ${levelBonus} level up bonus! 🎉`
    );
  } catch (error) {
    console.error("Failed to log bonus winner:", error);
  }
}

async function addLevelUpXpBonus(levelXpBonus, winnerId, channel) {
  const winnerBalance = await findUserBalance(winnerId);

  // Find the discordUsername of the winnerId from the backend
  try {
    const userResponse = await axios.get(
      process.env.BACKEND_BASE_URL+`/api/users/discord/${winnerId}`
    );
    if (userResponse.data && userResponse.data.user) {
      discordUsername = userResponse.data.user.discordUsername;
      userId = userResponse.data.user.userId;
    }
  } catch (error) {
    console.error(`Error fetching winner info for ${winnerId}:`, error.message);
    return;
  }

  console.log(
    `User with ID ${winnerId} won a level up bonus of ${levelXpBonus}!`
  );

  // Send the result to the backend
  try {
    await axios.post(process.env.BACKEND_BASE_URL+`/api/update-level`, {
      userId: userId,
      additionalXp: levelXpBonus,
      password: process.env.DISCORD_BOT_TOKEN,
    });
  } catch (error) {
    console.error("Failed to log bonus winner:", error);
  }
}

function extractLevel(message) {
  const regex = /(\d+)!$/; // Regular expression to capture a number before an exclamation point at the end
  const match = message.match(regex);

  if (match && match[1]) {
    return parseInt(match[1], 10); // Return the captured number as an integer
  } else {
    return null; // Return null if no match is found
  }
}

// Log in to Discord with your app's token
client.login(token);

// Once the bot is ready, log to the console
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

// Initialize the bot
initializeBot();
