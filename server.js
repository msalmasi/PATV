require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios'); // Ensure axios is imported
// 1.99afh: channel-point redemptions go to twitchbot/channelpoints.js (through twitch.js, which runs the chat client here
// too): the site pays allow-listed rewards only (never a number from the title), by the redeemer's Twitch user id, once
// per redemption id. Requests to Twitch / the site are logged as status + answer only (errInfo) - never their config,
// which carries tokens.
const CP = require("./twitchbot/channelpoints");
// 1.99afh review: before the chat bot starts (twitch.js connects on require) - an unhandled rejection (a !spin / raffle /
// chat line while the site or Twitch is down) is logged as status + answer and this process keeps running. Node 22 would
// exit and print the whole AxiosError (X-Bot-Token, X-PATV-Key) - and a crash inside the prod updater's stability check
// rolls the deploy back. An uncaught exception still exits (pm2 restarts it), logged the same way.
CP.guardProcess(process);
const { redeemChannelPoints } = require("./twitchbot/twitch");

const PORT = process.env.PORT || 3001;
const REDEMPTION_ADD = CP.REDEMPTION_ADD;

// The EventSub endpoint (POST /webhooks/callback): raw body kept for the signature, 403 on a bad one, the challenge as
// text/plain, 200 at once for a notification, then replays (> 10 min), repeated message ids, other subscription types and
// other channels (TWITCH_BROADCASTER_ID) dropped - channelpoints.webhookApp, which test/twitch-channelpoints.test.js drives.
const app = CP.webhookApp({
  express,
  bodyParser,
  secret: () => process.env.TWITCH_EVENTSUB_SECRET,
  broadcasterId: process.env.TWITCH_BROADCASTER_ID,
  onRedemption: redeemChannelPoints,
});

  async function createEventSubSubscription() {
    try {
      const callbackUrl = 'https://publicaccess.tv/webhooks/callback'; // Replace with your public URL (e.g., ngrok URL)

      const response = await axios.post(
        'https://api.twitch.tv/helix/eventsub/subscriptions',
        {
          type: REDEMPTION_ADD,
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

      const sub = response.data && Array.isArray(response.data.data) ? response.data.data[0] : null;
      console.log('Subscription created:', sub ? `${sub.id} ${sub.type} ${sub.status}` : 'ok');
    } catch (error) {
      console.error('Error creating subscription:', CP.errInfo(error));
    }
  }

  // At the end of server.js
// 1.99cf: loopback only - Twitch reaches it through nginx (https://publicaccess.tv/webhooks/callback)
require('./listen').listen(app, PORT, 'webhooks', async () => {
  try {
    console.log(`Webhook listener is running on ${require('./listen').bindHost()}:${PORT}`);

    // Delete all existing subscriptions
    await deleteAllSubscriptions();

    // Create a new subscription
    await createEventSubSubscription();
  } catch (error) {
    console.error('EventSub subscription setup failed:', CP.errInfo(error));
  }
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

      return response.data && Array.isArray(response.data.data) ? response.data.data : []; // Return the list of subscriptions
    } catch (error) {
      console.error('Error listing subscriptions:', CP.errInfo(error));
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
      console.error(`Error deleting subscription ${id}:`, CP.errInfo(error));
    }
  }

  // Function to delete all subscriptions
async function deleteAllSubscriptions() {
    const subscriptions = await listSubscriptions();
    for (const sub of subscriptions) {
      await deleteSubscription(sub.id);
    }
  }
