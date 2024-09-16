require('dotenv').config();
const axios = require('axios');

async function getUserIdByUsername() {
  try {
    const response = await axios.get('https://api.twitch.tv/helix/users', {
      params: {
        login: 'publicaccess_ttv', // Replace with your Twitch username
      },
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID2,
        'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN2}`,
      },
    });

    const user = response.data.data[0];
    console.log('Your Twitch User ID (Broadcaster ID) is:', user.id);
  } catch (error) {
    console.error('Error fetching user ID:', error.response ? error.response.data : error.message);
  }
}

getUserIdByUsername();