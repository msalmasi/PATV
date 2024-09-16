require('dotenv').config();
const axios = require('axios');

async function getAccessToken() {
  const params = new URLSearchParams();
  params.append('client_id', process.env.TWITCH_CLIENT_ID2);
  params.append('client_secret', process.env.TWITCH_SECRET_KEY2);
  params.append('grant_type', 'client_credentials');
  params.append('scope', 'channel:read:redemptions');

  try {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', params);
    console.log('Access Token:', response.data.access_token);
  } catch (error) {
    console.error('Error fetching access token:', error.response.data);
  }
}

getAccessToken();
