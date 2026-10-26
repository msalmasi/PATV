require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios'); // Ensure axios is imported
// 1.99afh: channel-point redemptions go to twitchbot/channelpoints.js (through twitch.js, which runs the chat client here
// too): the site pays allow-listed rewards only (never a number from the title), by the redeemer's Twitch user id, once
// per redemption id. Requests to Twitch / the site are logged as status + answer only (errInfo) - never their config,
// which carries tokens.
const { redeemChannelPoints } = require("./twitchbot/twitch");
const CP = require("./twitchbot/channelpoints");

const app = express();
const PORT = process.env.PORT || 3001;
const REDEMPTION_ADD = 'channel.channel_points_custom_reward_redemption.add';

// keep the raw body: Twitch signs the exact bytes it sent (a re-serialised JSON.stringify(req.body) can differ)
app.use(bodyParser.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const recentMessages = new CP.Recent(2000);

async function handleEvent(notification) {
    const redemption = notification && notification.event;
    if (!redemption || !redemption.reward) return;
    // only our channel's redemptions (the subscription is for TWITCH_BROADCASTER_ID)
    if (process.env.TWITCH_BROADCASTER_ID && String(redemption.broadcaster_user_id) !== String(process.env.TWITCH_BROADCASTER_ID)) {
      console.log(`Channel Point Redemption for another channel (${redemption.broadcaster_user_id}) - ignored`);
      return;
    }
    console.log(`Channel Point Redemption by ${redemption.user_name}: ${redemption.reward.title} (reward ${redemption.reward.id})`);
    await redeemChannelPoints(redemption);
  }

// Endpoint to receive webhook notifications
app.post('/webhooks/callback', (req, res) => {
  const headers = req.headers;
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  if (!CP.verifySignature(process.env.TWITCH_EVENTSUB_SECRET, headers, raw)) {
    console.error('Could not verify message signature');
    return res.status(403).send('Forbidden');
  }
  const notification = req.body || {};
  const type = headers['twitch-eventsub-message-type'];
  if (type === 'webhook_callback_verification') {
    // Respond to the challenge during subscription verification (the raw string only)
    return res.status(200).type('text/plain').send(String(notification.challenge || ''));
  }
  if (type === 'revocation') {
    console.log(`Subscription revoked: ${notification.subscription && notification.subscription.status}`);
    return res.status(200).end();
  }
  if (type !== 'notification') return res.status(200).end();
  // 2xx straight away (Twitch re-sends what isn't answered within a few seconds), then handle it once:
  // an old (replayed) or already-seen message is acknowledged and dropped
  res.status(200).end();
  if (!CP.fresh(headers['twitch-eventsub-message-timestamp'])) {
    console.warn(`EventSub message ${headers['twitch-eventsub-message-id']} is older than 10 minutes - ignored`);
    return;
  }
  if (!recentMessages.add(headers['twitch-eventsub-message-id'])) return;
  if (!notification.subscription || notification.subscription.type !== REDEMPTION_ADD) return;
  handleEvent(notification).catch((e) => console.error('Channel point redemption failed:', CP.errInfo(e)));
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
    console.log(`Webhook listener is running on ${require('./listen').bindHost()}:${PORT}`);

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
