const { Client } = require('discord.js-selfbot-v13');
const https = require('https');
const client = new Client();
const { token } = require("./config.json");

const POKERNOW_BOT = '613156357239078913';
const PATV_BOT = '926267272501272636';
const BACKEND = process.env.BACKEND_BASE_URL || 'https://publicaccess.tv';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── PokerNow new-game registration ─────────────────────────────────────────────
// The selfbot invokes /new-game, so it (not the PATV bot) reliably sees the result —
// even if PokerNow replies ephemerally. We register the game directly against the
// backend, attributed to the host whose <@id> we received in the !png trigger.
const registeredGames = new Set();   // pokerNowId -> already registered (dedup)
let pendingHost = null;              // { hostId, at } for the most recent !png

function httpsJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json' },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch (e) {}
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function extractGame(text) {
  if (!text) return null;
  const s = String(text);
  // Blinds from the standard phrasing; fall back to any x/y if wording shifts.
  const blindsMatch = s.match(/new (\d+\/\d+) game/) || s.match(/(\d+\/\d+)/);
  const urlMatch = s.match(/(https?:\/\/(?:www\.)?pokernow\.(?:club|com)\/games\/([\w\-]+))/i);
  if (!urlMatch) return null;
  return {
    blinds: blindsMatch ? blindsMatch[1] : '',
    url: urlMatch[1],
    pokerNowId: urlMatch[2],
  };
}

// Pull any candidate text out of a message/interaction reply (content + embeds).
function gameFromMessage(msg) {
  if (!msg) return null;
  const texts = [];
  if (msg.content) texts.push(msg.content);
  if (Array.isArray(msg.embeds)) {
    for (const e of msg.embeds) {
      if (e && e.description) texts.push(e.description);
      if (e && Array.isArray(e.fields)) for (const f of e.fields) if (f && f.value) texts.push(f.value);
    }
  }
  for (const t of texts) {
    const g = extractGame(t);
    if (g) return g;
  }
  return null;
}

async function registerGame(game, hostId) {
  if (!game || registeredGames.has(game.pokerNowId)) return;
  registeredGames.add(game.pokerNowId); // claim early to avoid double-registration races
  try {
    let userId = null;
    if (hostId) {
      const u = await httpsJson('GET', `${BACKEND}/api/users/discord/${hostId}`);
      if (u.data && u.data.user) userId = u.data.user.userId;
    }
    if (!userId) {
      console.error('registerGame: could not resolve host userId for', hostId);
      registeredGames.delete(game.pokerNowId); // let a later signal retry
      return;
    }
    const r = await httpsJson('POST', `${BACKEND}/api/pokernow/add`, {
      pokerNowId: game.pokerNowId,
      userId,
      url: game.url,
      blinds: game.blinds,
    });
    if (r.status === 200) {
      console.log(`Registered PokerNow game ${game.pokerNowId} (host ${hostId})`);
    } else {
      console.error('registerGame failed:', r.status, r.data);
    }
  } catch (e) {
    console.error('registerGame error:', e && e.message);
    registeredGames.delete(game.pokerNowId);
  }
}

client.on('ready', async () => {
  console.log(`${client.user.username} is ready!`);
});

client.on("messageCreate", async (message) => {
  // Buy-in: PATV bot posts "!pac <@id> <amount>" -> add chips
  if (message.author.id == PATV_BOT && message.content.startsWith('!pac')) {
    const parts = message.content.split(' ');
    if (parts.length === 3) {
      const mention = parts[1];
      const number = parts[2];
      const userId = mention.match(/^<@!?(\d+)>$/);
      if (userId) {
        console.log('User ID:', userId[1], 'Number:', number);
        message.channel.sendSlash(POKERNOW_BOT, 'admin-chips add', userId[1], number);
      } else {
        console.log('Invalid mention format');
      }
    } else {
      console.log('Invalid command format');
    }
  }

  // New game: PATV bot posts "!png <sb>/<bb> <@hostId>" -> run /new-game, then register.
  if (message.author.id == PATV_BOT && message.content.startsWith('!png')) {
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
    pendingHost = { hostId, blinds, at: Date.now() };
    console.log(`New game: sb=${sb} bb=${bb} host=${hostId}`);
    try {
      // /new-game [small blind] [big blind]. PokerNow posts the reply WITHOUT the URL,
      // then edits the URL in a moment later — so we can't trust the immediate reply or
      // rely on edit events firing. Poll the channel for the PokerNow bot's message and
      // read its current (edited) content.
      const reply = await message.channel.sendSlash(POKERNOW_BOT, 'new-game', sb, bb);
      let g = gameFromMessage(reply);
      for (let i = 0; i < 12 && !g; i++) {
        await sleep(1500);
        try {
          const recent = await message.channel.messages.fetch({ limit: 8 });
          for (const [, m] of recent) {
            if (m.author && m.author.id === POKERNOW_BOT) {
              const cand = gameFromMessage(m);
              if (cand && !registeredGames.has(cand.pokerNowId)) { g = cand; break; }
            }
          }
        } catch (e) {}
      }
      if (g) {
        if (!g.blinds) g.blinds = blinds; // fall back to the blinds from the trigger
        await registerGame(g, hostId);
      } else {
        console.error('new-game: URL not found in channel after polling');
      }
    } catch (err) {
      console.error('new-game slash failed:', err && err.message);
    }
  }

  // Cash-out: PATV bot posts "!prc <@id> <amount>" -> remove chips
  if (message.author.id == PATV_BOT && message.content.startsWith('!prc')) {
    const parts = message.content.split(' ');
    if (parts.length === 3) {
      const mention = parts[1];
      const number = parts[2];
      const userId = mention.match(/^<@!?(\d+)>$/);
      if (userId) {
        console.log('User ID:', userId[1], 'Number:', number);
        message.channel.sendSlash(POKERNOW_BOT, 'admin-chips remove', userId[1], number);
      } else {
        console.log('Invalid mention format');
      }
    } else {
      console.log('Invalid command format');
    }
  }

  // Fallback: PokerNow posts the new-game URL publicly.
  if (message.author.id == POKERNOW_BOT && pendingHost && Date.now() - pendingHost.at < 120000) {
    const g = gameFromMessage(message);
    if (g) { if (!g.blinds) g.blinds = pendingHost.blinds; await registerGame(g, pendingHost.hostId); }
  }
});

// Fallback: PokerNow edits its message to include the URL (mirrors the human flow).
client.on("messageUpdate", async (oldMessage, newMessage) => {
  if (!newMessage || !newMessage.author) return;
  if (newMessage.author.id == POKERNOW_BOT && pendingHost && Date.now() - pendingHost.at < 120000) {
    const g = gameFromMessage(newMessage);
    if (g) { if (!g.blinds) g.blinds = pendingHost.blinds; await registerGame(g, pendingHost.hostId); }
  }
});

client.login(token);
