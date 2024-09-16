require('dotenv').config();
const axios = require('axios');

async function validateAccessToken() {
  try {
    const response = await axios.get('https://id.twitch.tv/oauth2/validate', {
      headers: {
        Authorization: `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
      },
    });
    console.log('Access Token is valid.');
    console.log('Client ID:', response.data.client_id);
    console.log('User ID:', response.data.user_id);
    console.log('Scopes:', response.data.scopes);
  } catch (error) {
    console.error('Invalid Access Token:', error.response ? error.response.data : error.message);
  }
}

validateAccessToken();