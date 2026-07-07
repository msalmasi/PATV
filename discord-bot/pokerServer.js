// pokerServer.js — HTTP bridge so the Camfrog bot can drive PokerNow chips/games.
//
// The Camfrog bot (Python) can't post to Discord, but the selfbot only reacts to
// !pac / !prc / !png posted BY this bot in #poker. So this tiny HTTP server lets the
// Camfrog bot ask us to (a) charge PAT + post !pac (buy-in), (b) post !prc (cash-out),
// (c) post !png (new game). Downstream is all existing machinery:
//   - !pac/!prc  -> selfbot -> PokerNow /admin-chips add|remove
//   - !png       -> selfbot -> PokerNow /new-game   (selfbot handler added separately)
//   - new-game URL + "chips removed" confirmations are caught by discord.js messageUpdate,
//     which registers the game (/api/pokernow/add) and credits cash-out PAT.
//
// Cash-out therefore does NOT touch the cashier here: PAT is credited only after PokerNow
// confirms the removal (and refused if the stack is short — free stack validation).

const http = require('http');
const axios = require('axios');

const POKER_CHANNEL_ID = '1243767733762392134'; // #poker

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

async function resolveCamfrog(camfrogUsername) {
  const r = await axios.get(
    `${process.env.BACKEND_BASE_URL}/api/users/camfrog/${encodeURIComponent(camfrogUsername)}`
  );
  return r.data.user; // { userId, username, discordId, discordUsername, points_balance, ... }
}

async function getBalance(username) {
  try {
    const r = await axios.get(
      `${process.env.BACKEND_BASE_URL}/api/u/${encodeURIComponent(username)}/balance`
    );
    return r.data.balance;
  } catch (e) {
    return null;
  }
}

// POST /poker/chips  { camfrogUsername, amount, action:"buyin"|"cashout" }
async function handleChips(client, body, res) {
  const { camfrogUsername, action } = body;
  const amount = Math.floor(Number(body.amount));

  if (!camfrogUsername) return send(res, 400, { error: 'missing_user' });
  if (!Number.isFinite(amount) || amount <= 0) return send(res, 400, { error: 'bad_amount' });
  if (action !== 'buyin' && action !== 'cashout') return send(res, 400, { error: 'bad_action' });

  let user;
  try {
    user = await resolveCamfrog(camfrogUsername);
  } catch (e) {
    if (e.response && e.response.status === 404) return send(res, 404, { error: 'no_account' });
    throw e;
  }
  if (!user || !user.userId) return send(res, 404, { error: 'no_account' });
  if (!user.discordId) return send(res, 409, { error: 'no_discord', username: user.username });

  const channel = await client.channels.fetch(POKER_CHANNEL_ID);

  if (action === 'buyin') {
    let balance;
    try {
      const r = await axios.post(`${process.env.BACKEND_BASE_URL}/api/poker/cashier`, {
        userId: user.userId,
        amount,
        action: 'buyin',
      });
      balance = r.data.balance;
    } catch (e) {
      const data = e.response && e.response.data;
      if (typeof data === 'string' && data.includes('Insufficient')) {
        const bal = await getBalance(user.username);
        return send(res, 402, { error: 'insufficient', balance: bal });
      }
      throw e;
    }
    // Chips added to the user's seated Discord account via selfbot -> PokerNow.
    await channel.send(`!pac <@${user.discordId}> ${amount}`);
    return send(res, 200, { ok: true, action: 'buyin', amount, balance });
  }

  // cashout: only post the trigger. PAT is credited by discord.js messageUpdate once
  // PokerNow confirms the removal (and refused if the stack is short).
  await channel.send(`!prc <@${user.discordId}> ${amount}`);
  return send(res, 200, { ok: true, action: 'cashout', amount, pending: true });
}

// POST /poker/newgame  { camfrogUsername, blinds }
// Posts !png so the selfbot runs PokerNow /new-game. The resulting game URL is registered
// + announced by the existing discord.js messageUpdate listener. (Requires the selfbot's
// !png handler — until that lands this just drops an inert !png in #poker.)
async function handleNewGame(client, body, res) {
  const { camfrogUsername } = body;
  const blinds = (body.blinds || '').toString().trim();

  if (!camfrogUsername) return send(res, 400, { error: 'missing_user' });

  let user;
  try {
    user = await resolveCamfrog(camfrogUsername);
  } catch (e) {
    if (e.response && e.response.status === 404) return send(res, 404, { error: 'no_account' });
    throw e;
  }
  if (!user || !user.discordId) return send(res, 409, { error: 'no_discord' });

  const channel = await client.channels.fetch(POKER_CHANNEL_ID);
  await channel.send(`!png ${blinds} <@${user.discordId}>`.replace(/\s+/g, ' ').trim());
  return send(res, 200, { ok: true, pending: true });
}

function start(client) {
  const PORT = process.env.POKER_BRIDGE_PORT || 3020;
  const HOST = process.env.POKER_BRIDGE_HOST || '127.0.0.1';
  const SECRET = process.env.POKER_BRIDGE_SECRET;

  if (!SECRET) {
    console.warn('[poker-bridge] POKER_BRIDGE_SECRET is not set — bridge will refuse all requests.');
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    if (!SECRET || req.headers['x-bot-secret'] !== SECRET) {
      return send(res, 401, { error: 'unauthorized' });
    }

    let body;
    try { body = await readBody(req); }
    catch (e) { return send(res, 400, { error: 'bad_json' }); }

    const path = (req.url || '').split('?')[0];
    try {
      if (path === '/poker/chips') return await handleChips(client, body, res);
      if (path === '/poker/newgame') return await handleNewGame(client, body, res);
      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      console.error('[poker-bridge] handler error:', err && err.message);
      return send(res, 500, { error: 'server_error' });
    }
  });

  server.on('error', (e) => console.error('[poker-bridge] server error:', e && e.message));
  server.listen(PORT, HOST, () => {
    console.log(`[poker-bridge] listening on ${HOST}:${PORT}`);
  });

  return server;
}

module.exports = { start };
