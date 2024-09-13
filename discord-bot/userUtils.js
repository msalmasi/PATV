const bcrypt = require('bcrypt');
const axios = require("axios");

// Creates a new user with Discord
async function createDiscordUser(discordId, discordUsername, profileImage) {
    try {
      const password = Math.random().toString(36).substring(2, 15);
      const hashedPassword = await bcrypt.hash(password, 12);
  
      // Check if the username is already taken
      let username = discordUsername;
      username = await generateUniqueUsername(username);
      ;
      const newUser = {
        username: username, // Use the unique username
        displayname: discordUsername,
        email: Math.random().toString(36).substring(2, 15), // No email for Discord-based users unless you have it
        password: hashedPassword,
        discordId: discordId,
        discordUsername: discordUsername,
        avatar: `https://cdn.discordapp.com/avatars/${discordId}/${profileImage}.png` || "/public/img/avatar.png",
        points_balance: 50000,
      };
  
      const response = await axios.post(
        "https://publicaccess.tv/api/users/discord/register",
        newUser
      );
      return response.data.user; // Returns the new user data
    } catch (error) {
      console.error("Error creating new Discord user:", error.message);
      return null;
    }
  }
  
  // In case of username collision, generate a unique username.
  async function generateUniqueUsername(baseUsername) {
    let username = baseUsername;
    let isUnique = false;
    let counter = 1;
    while (!isUnique) {
      // Check if the username already exists in the database
      const existingUserResponse = await axios.get(
        `https://publicaccess.tv/api/users/username/${username}`
      );
      if (existingUserResponse.data && existingUserResponse.data.exists) {
        // Username exists, append a number and check again
        username = `${baseUsername}${counter}`;
        counter++;
      } else {
        // Username is unique
        isUnique = true;
      }
    }
  
    return username; // Return the unique username
  }

// Find an existing user with discordId or automatically create a new user for spins.
async function findOrCreateDiscordUser(discordId, discordUsername, avatarUrl) {
    try {
      // Check if user already exists in your backend
      const userResponse = await axios.get(`https://publicaccess.tv/api/users/discord/${discordId}`);
      
      if (userResponse.data && userResponse.data.user) {
        return userResponse.data.user;
      } else {
        // Create new user if they don't exist
        const newUser = await createDiscordUser(
          discordId,
          discordUsername,
          avatarUrl,
        );
        if (newUser) {
            console.log(`New user ${newUser.username} created.`);
            console.log(newUser);
            return newUser;
          } else {
            throw new Error("Error creating new Discord user");
          }
      }
    } catch (error) {
      console.error("Error finding or creating Discord user:", error.message);
      throw error;
    }
  }

  // Find a users balance
async function findUserBalance(discordId) {
    try {
      // Step 1: Check if the user already exists in the backend
      const userResponse = await axios.get(
        `https://publicaccess.tv/api/users/discord/${discordId}`
      );
      if (userResponse.data && userResponse.data.user) {
        // User found, return the existing user data
        const currentUser = userResponse.data.user;
        console.log(`User ${currentUser.username} found.`);
        const userBalanceResponse = await axios.get(
          `https://publicaccess.tv/api/u/${currentUser.username}/balance`
        );
        const userBalance = userBalanceResponse.data.balance;
        return userBalance;
      } else {
        // User doesn't exist, create a new one
        console.log(`Discord user with ID ${discordId} not found.`);
      }
    } catch (error) {
      console.error("Error finding Discord user:", error.message);
      throw error;
    }
  }

  module.exports = {
    findOrCreateDiscordUser,
    findUserBalance
  };