// botBridge.js — the Discord bot's local HTTP bridge: lets the other services ask THIS bot to do
// things on Discord. Secret-protected (X-Bot-Secret = BOT_BRIDGE_SECRET). Formerly pokerServer.js.
//
//   /store/purchase, /store/role-members   the PATV backend's prize store (index.js): announce
//                                          website/Camfrog sales, grant role prizes, list holders
//   /store/role-grant, /store/role-remove  1.99la: one store role on its own (requestroles.js)
//   /poker/chips, /poker/newgame           Pepe's PokerNow bridge (off in Camfrog since the
//                                          built-in Hold'em; kept working). Details below.
//
// PokerNow: the Camfrog bot (Python) can't post to Discord, but the selfbot only reacts to
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

// ─── Prize store (called by the PATV backend, index.js purchasePrize) ───────────────────────
const PURCHASES_CHANNEL_ID = '1245478269294346320'; // where the Discord shop announces sales

async function guildMember(client, discordId) {
  const channel = await client.channels.fetch(PURCHASES_CHANNEL_ID);
  const guild = channel.guild;
  const member = await guild.members.fetch(discordId).catch(() => null);
  return { channel, guild, member };
}

// POST /store/purchase { username, camfrogUsername, discordId, prize, cost, source, role }
// A website or Camfrog purchase: announce it like the Discord shop does, and grant the role.
async function handleStorePurchase(client, body, res) {
  const { username, camfrogUsername, discordId, prize, source, role } = body;
  if (!prize) return send(res, 400, { error: 'missing_prize' });
  const { channel, guild, member } = discordId ? await guildMember(client, discordId)
                                               : { channel: await client.channels.fetch(PURCHASES_CHANNEL_ID) };
  const who = member ? `${member}` : (camfrogUsername ? `${username} (Camfrog: ${camfrogUsername})` : username);
  const where = source === 'camfrog' ? 'in Camfrog' : source === 'website' ? 'on the website' : `via ${source}`;
  await channel.send(`${who} bought ${prize} ${where}`);

  if (!role) return send(res, 200, { ok: true });
  if (!discordId) return send(res, 200, { ok: true, granted: false, reason: 'no_discord' });
  if (!member) return send(res, 200, { ok: true, granted: false, reason: 'not_in_server' });
  const r = guild.roles.cache.find((x) => x.name.toLowerCase() === String(role).toLowerCase());
  if (!r) return send(res, 200, { ok: true, granted: false, reason: 'no_such_role' });
  await member.roles.add(r);
  return send(res, 200, { ok: true, granted: true });
}

// The whole member list, at most once every 2 minutes: Discord rate-limits the gateway's member
// request, and two lookups in a row used to fail with "Members didn't arrive in time".
let membersAt = 0;
async function fetchAllMembers(guild) {
  if (Date.now() - membersAt < 120000) return;
  try { await guild.members.fetch(); membersAt = Date.now(); }
  catch (e) { if (!membersAt) throw e; }     // an earlier full fetch is still in the cache
}

// POST /store/role-members { role } -> { discordIds: [...] } — who holds a role in the server.
async function handleRoleMembers(client, body, res) {
  const channel = await client.channels.fetch(PURCHASES_CHANNEL_ID);
  const guild = channel.guild;
  await fetchAllMembers(guild);
  const r = guild.roles.cache.find((x) => x.name.toLowerCase() === String(body.role || '').toLowerCase());
  if (!r) return send(res, 404, { error: 'no_such_role' });
  return send(res, 200, { role: r.name, discordIds: r.members.map((m) => m.id) });
}

// 1.99la (requestroles.js): give / take a store role on its own, outside a sale - a role bought
// before the buyer linked Discord, an admin's grant, or a revoke. Idempotent; says what it found.
// POST /store/role-grant  { discordId, role } -> { granted, already } | { granted:false, reason }
// POST /store/role-remove { discordId, role } -> { removed, had }     | { removed:false, reason }
async function handleRoleChange(client, body, res, add) {
  const discordId = String(body.discordId || '');
  if (!/^\d{5,25}$/.test(discordId)) return send(res, 400, { error: 'bad_discord_id' });
  const { guild, member } = await guildMember(client, discordId);
  const key = add ? 'granted' : 'removed';
  if (!member) return send(res, 200, { ok: true, [key]: false, reason: 'not_in_server' });
  const r = guild.roles.cache.find((x) => x.name.toLowerCase() === String(body.role || '').toLowerCase());
  if (!r) return send(res, 200, { ok: true, [key]: false, reason: 'no_such_role' });
  const had = member.roles.cache.has(r.id);
  if (add && !had) await member.roles.add(r, 'PATV store role');
  if (!add && had) await member.roles.remove(r, 'PATV store role revoked');
  return send(res, 200, add ? { ok: true, granted: true, already: had } : { ok: true, removed: had, had });
}


// 1.99agj: public stage starts. Canonical PATV links and explicit role IDs only.
const PATV_GUILD_ID = '913269267691094026';
const stageId = (v) => typeof v === 'string' && /^\d{5,25}$/.test(v);
function stageUrl(v) {
  if (typeof v !== 'string' || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && ['publicaccess.tv', 'pa.tv'].includes(u.hostname) && !u.username && !u.password && !u.port;
  } catch (e) { return false; }
}
const stageText = (v, n) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '';
// review fix: shown text is escaped Discord markdown - a title can't post a masked link ([text](url)), a # heading or
// formatting through the official bot (the role tags are still read from the raw title)
const stageMd = (s) => s.replace(/[\\`*_~|>\[\]()<#]/g, '\\$&');
async function handleStageGoLive(client, body, res) {
  if (process.env.STAGING) return send(res, 409, { error: 'staging_disabled' });
  if (!body || !stageId(body.channel_id) || (body.role_id != null && !stageId(body.role_id))) return send(res, 400, { error: 'bad_channel_or_role' });
  if (!stageUrl(body.url) || (body.thumb != null && !stageUrl(body.thumb))) return send(res, 400, { error: 'bad_url' });
  const pad = body.pad, streamer = stageText(body.streamer, 40), title = stageText(body.title, 200);
  if (!pad || typeof pad.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(pad.slug) ||
      !stageText(pad.title, 60) || !streamer || typeof body.title !== 'string' ||
      !['stage', 'embed', 'plex', 'twitch', 'test'].includes(body.kind) ||
      new URL(body.url).pathname !== '/p/' + pad.slug || (body.test != null && typeof body.test !== 'boolean')) {
    return send(res, 400, { error: 'bad_alert' });
  }
  const channel = await client.channels.fetch(body.channel_id);
  if (!channel || !channel.guild || channel.guild.id !== PATV_GUILD_ID) return send(res, 403, { error: 'foreign_guild' });
  if (!channel.isTextBased() || typeof channel.send !== 'function') return send(res, 400, { error: 'not_text_channel' });
  let roles = [];
  if (!body.test && (body.role_id || title.includes('@'))) {
    const available = [...(await channel.guild.roles.fetch()).values()];
    if (body.role_id) {
      const r = available.find((r) => r.id === body.role_id && r.id !== PATV_GUILD_ID);
      if (!r) return send(res, 400, { error: 'bad_role' });
      roles = [r.id];
    } else {
      // Any streamer may tag a mentionable role. Quoted tags support spaces: @"Movie Night".
      // Exact case-insensitive names; ambiguous names, raw IDs, everyone and here never ping.
      const tags = [...title.matchAll(/(?:^|\s)@(?:"([^"\r\n]{1,100})"|([\p{L}\p{N}_-]+))(?=$|\s|[.,!?;:])/gu)];
      for (const tag of tags) {
        const name = (tag[1] || tag[2]).toLowerCase();
        if (name === 'everyone' || name === 'here') continue;
        const matches = available.filter((r) => r.id !== PATV_GUILD_ID && r.name.toLowerCase() === name);
        if (matches.length === 1 && matches[0].mentionable) roles.push(matches[0].id);
      }
      roles = [...new Set(roles)];
    }
  }
  const embed = { title: (body.test ? '🧪 TEST — ' : '🎥 ') + stageMd(streamer) + ' is live on ' + stageMd(stageText(pad.title, 60)),
    description: title ? stageMd(title) : undefined, url: body.url, footer: { text: 'PATV stages' } };
  if (body.thumb) embed.thumbnail = { url: body.thumb };
  const posted = await channel.send({ content: roles.map((id) => '<@&' + id + '>').join(' '), embeds: [embed],
    allowedMentions: { parse: [], users: [], roles, repliedUser: false } });
  return send(res, 200, { ok: true, id: posted.id });
}

// h22 phase 2 (1.99amj): a scheduled poker tournament's channel post (casino/mtt.js discord(): reg_open | starting | final | winner) - the
// stage pattern: never on staging, a channel in the PATV guild, the canonical tournament link only, escaped text, and only the configured
// role pinged (on 'starting' alone; never @everyone / @here). One post per (tournament, kind) is the site's (its casino_mtt_log key).
const TOURNEY_KINDS = ['reg_open', 'starting', 'final', 'winner'];
const fmtPat = (n) => Math.trunc(Number(n) || 0).toLocaleString('en-US');
async function handleCasinoTourney(client, body, res) {
  if (process.env.STAGING) return send(res, 409, { error: 'staging_disabled' });
  if (!body || !stageId(body.channel_id) || (body.role_id != null && !stageId(body.role_id))) return send(res, 400, { error: 'bad_channel_or_role' });
  if (!stageUrl(body.url) || !/^\/casino\/holdem\/mtt\/m[0-9a-f]{9}$/.test(new URL(body.url).pathname)) return send(res, 400, { error: 'bad_url' });
  const title = stageText(body.title, 60), kind = body.kind;
  if (!title || !TOURNEY_KINDS.includes(kind) || !Number.isInteger(body.no) || body.no < 1) return send(res, 400, { error: 'bad_post' });
  const channel = await client.channels.fetch(body.channel_id);
  if (!channel || !channel.guild || channel.guild.id !== PATV_GUILD_ID) return send(res, 403, { error: 'foreign_guild' });
  if (!channel.isTextBased() || typeof channel.send !== 'function') return send(res, 400, { error: 'not_text_channel' });
  let roles = [];
  if (kind === 'starting' && body.role_id) {
    const available = [...(await channel.guild.roles.fetch()).values()];
    const r = available.find((x) => x.id === body.role_id && x.id !== PATV_GUILD_ID);
    if (r) roles = [r.id];
  }
  // (review) 'starting' goes out at the 15-minute mark (or at an admin's start-now): its words follow the clock
  const due = Number(body.start_at) > 0 && Number(body.start_at) <= Date.now() + 30000;
  const head = { reg_open: '🏆 Registration is open', starting: due ? '🏆 Starting now' : '🏆 Starting soon', final: '🏆 Final table', winner: '🏆 Winner' }[kind];
  const buyin = Number(body.buyin) > 0 ? `${fmtPat(body.buyin)} + ${fmtPat(body.fee)} PAT` : 'Freeroll';
  const lines = [`Buy-in: ${buyin}`];
  if (Number(body.guarantee) > 0) lines.push(`🛡 ${fmtPat(body.guarantee)} PAT guaranteed`);
  if (Number(body.start_at) > 0) lines.push(`Starts <t:${Math.floor(Number(body.start_at) / 1000)}:f>`);
  if (kind === 'winner' && body.winner) lines.push(`🏆 ${stageMd(stageText(body.winner, 40))} wins!`);
  const embed = { title: `${head}: #${body.no} ${stageMd(title)}`, description: lines.join('\n'), url: body.url, footer: { text: 'PATV poker tournaments' } };
  const posted = await channel.send({ content: roles.map((id) => '<@&' + id + '>').join(' '), embeds: [embed],
    allowedMentions: { parse: [], users: [], roles, repliedUser: false } });
  return send(res, 200, { ok: true, id: posted.id });
}

function start(client) {
  // BOT_BRIDGE_*; the old POKER_BRIDGE_* names still work.
  const env = (k) => process.env[`BOT_BRIDGE_${k}`] || process.env[`POKER_BRIDGE_${k}`];
  const PORT = env('PORT') || 3020;
  const HOST = env('HOST') || '127.0.0.1';
  const SECRET = env('SECRET');

  if (!SECRET) {
    console.warn('[bot-bridge] BOT_BRIDGE_SECRET is not set — bridge will refuse all requests.');
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
      if (path === '/stage/golive') return await handleStageGoLive(client, body, res);
      if (path === '/casino/tourney') return await handleCasinoTourney(client, body, res);      // h22 phase 2
      if (path === '/poker/chips') return await handleChips(client, body, res);
      if (path === '/poker/newgame') return await handleNewGame(client, body, res);
      if (path === '/store/purchase') return await handleStorePurchase(client, body, res);
      if (path === '/store/role-members') return await handleRoleMembers(client, body, res);
      if (path === '/store/role-grant') return await handleRoleChange(client, body, res, true);
      if (path === '/store/role-remove') return await handleRoleChange(client, body, res, false);
      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      console.error('[bot-bridge] handler error:', err && err.message);
      return send(res, 500, { error: 'server_error' });
    }
  });

  server.on('error', (e) => console.error('[bot-bridge] server error:', e && e.message));
  server.listen(PORT, HOST, () => {
    console.log(`[bot-bridge] listening on ${HOST}:${PORT}`);
  });

  return server;
}

module.exports = { start };
