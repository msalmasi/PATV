require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios'); // Ensure axios is imported
const { exchangeChannelPoints } = require("./twitchbot/twitch"); 

const app = express();
const PORT = process.env.PORT || 3001;

app.use(bodyParser.json());

async function handleEvent(notification) {
    const redemption = notification.event;
    const { user_name, user_id, reward, id } = redemption;
  
    console.log(`Channel Point Redemption by ${user_name}: ${reward.title}`);
    const points = reward.title.split(" ")[1];
    const twitchDisplayname = user_name;
    await exchangeChannelPoints(points, twitchDisplayname);
  
    // Implement your custom logic here
    // For example, award points, trigger actions, etc.
  
    // Example: Acknowledge the redemption via the Twitch API (optional)
    // await acknowledgeRedemption(id, user_id);
  }

// Endpoint to receive webhook notifications
app.post('/webhooks/callback', (req, res) => {
  const message = getHmacMessage(req);
  const hmac = hmacSHA256(message);

  if (verifyMessage(hmac, req.headers['twitch-eventsub-message-signature'])) {
    const notification = req.body;

    if (req.headers['twitch-eventsub-message-type'] === 'webhook_callback_verification') {
      // Respond to the challenge during subscription verification
      res.status(200).send(notification.challenge);
    } else if (req.headers['twitch-eventsub-message-type'] === 'notification') {
      // Handle the event notification
      handleEvent(notification);
      res.status(200).end();
    } else if (req.headers['twitch-eventsub-message-type'] === 'revocation') {
      console.log(`Subscription revoked: ${notification.subscription.status}`);
      res.status(200).end();
    } else {
      res.status(200).end();
    }
  } else {
    console.error('Could not verify message signature');
    res.status(403).send('Forbidden');
  }
});

function getHmacMessage(req) {
    const messageId = req.headers['twitch-eventsub-message-id'];
    const timestamp = req.headers['twitch-eventsub-message-timestamp'];
    const body = JSON.stringify(req.body);
    return messageId + timestamp + body;
  }
  
  function hmacSHA256(message) {
    return crypto
      .createHmac('sha256', process.env.TWITCH_EVENTSUB_SECRET)
      .update(message)
      .digest('hex');
  }
  
  function verifyMessage(hmac, twitchSignature) {
    return `sha256=${hmac}` === twitchSignature;
  }
  
  async function createEventSubSubscription() {
    try {
      const callbackUrl = 'https://publicaccess.tv/webhooks/callback'; // Replace with your public URL (e.g., ngrok URL)
  
      const response = await axios.post(
        'https://api.twitch.tv/helix/eventsub/subscriptions',
        {
          type: 'channel.channel_points_custom_reward_redemption.add',
          version: '1',
          condition: {
            broadcaster_user_id: process.env.TWITCH_BROADCASTER_ID,
          },
          transport: {
            method: 'webhook',
            callback: callbackUrl,
            secret: process.env.TWITCH_EVENTSUB_SECRET,
          },
        },
        {
          headers: {
            'Client-ID': process.env.TWITCH_CLIENT_ID2,
            Authorization: `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        }
      );
  
      console.log('Subscription created:', response.data);
    } catch (error) {
      console.error('Error creating subscription:', error.response.data);
    }
  }

  // At the end of server.js
app.listen(PORT, async () => {
    console.log(`Webhook listener is running on port ${PORT}`);
  
// Delete all existing subscriptions
  await deleteAllSubscriptions();

  // Create a new subscription
  await createEventSubSubscription();
  });

// Function to list all current EventSub subscriptions
async function listSubscriptions() {
    try {
      const response = await axios.get('https://api.twitch.tv/helix/eventsub/subscriptions', {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID2,
          Authorization: `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
        },
      });
  
      return response.data.data; // Return the list of subscriptions
    } catch (error) {
      console.error('Error listing subscriptions:', error.response ? error.response.data : error.message);
      return [];
    }
  }
  
  // Function to delete a subscription by ID
  async function deleteSubscription(id) {
    try {
      await axios.delete('https://api.twitch.tv/helix/eventsub/subscriptions', {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID2,
          Authorization: `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
        },
        params: {
          id: id,
        },
      });
      console.log(`Deleted subscription: ${id}`);
    } catch (error) {
      console.error(`Error deleting subscription ${id}:`, error.response ? error.response.data : error.message);
    }
  }

  // Function to delete all subscriptions
async function deleteAllSubscriptions() {
    const subscriptions = await listSubscriptions();
    for (const sub of subscriptions) {
      await deleteSubscription(sub.id);
    }
  }