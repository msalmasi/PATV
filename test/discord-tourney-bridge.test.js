"use strict";
// h22 phase 2 (1.99??): discord-bot/botBridge.js POST /casino/tourney - a scheduled poker tournament's channel post (casino/mtt.js): never on
// staging (409 staging_disabled), the canonical /casino/holdem/mtt/<id> link only, a channel in the PATV guild, escaped text, and only the
// configured role pinged on 'starting' (allowedMentions limited to it; never @everyone / @here). One post per (tournament, kind) is the site's.
const test = require("node:test"), assert = require("node:assert/strict");
process.env.BOT_BRIDGE_PORT = "0"; process.env.BOT_BRIDGE_HOST = "127.0.0.1"; process.env.BOT_BRIDGE_SECRET = "fake-test-secret";
delete process.env.STAGING;
const guildId = "913269267691094026";
let messages = [], foreign = false;
const roles = new Map([["111111", { id: "111111", name: "poker", mentionable: true }], [guildId, { id: guildId, name: "@everyone", mentionable: true }]]);
const client = { channels: { fetch: async () => ({ guild: { id: foreign ? "other" : guildId, roles: { fetch: async () => roles } },
  isTextBased: () => true, send: async (m) => { messages.push(m); return { id: "message-id" }; } }) } };
let server, base;
const valid = { channel_id: "1206395925191200790", kind: "starting", title: "Sunday Stack", no: 12, start_at: Date.UTC(2026, 11, 6, 1, 0, 0), buyin: 5000, fee: 500,
                guarantee: 0, role_id: "111111", url: "https://publicaccess.tv/casino/holdem/mtt/m012345678" };
async function post(body = valid, secret = "fake-test-secret") {
  const r = await fetch(base + "/casino/tourney", { method: "POST", headers: { "Content-Type": "application/json", "X-Bot-Secret": secret }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
test.before(async () => { server = require("../discord-bot/botBridge").start(client); await new Promise((r) => server.once("listening", r)); base = "http://127.0.0.1:" + server.address().port; });
test.beforeEach(() => { messages = []; foreign = false; });
test.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });

test("staging never posts (409 staging_disabled); the secret; a foreign guild 403", async () => {
  process.env.STAGING = "1";
  assert.deepEqual(await post(), { status: 409, body: { error: "staging_disabled" } });
  delete process.env.STAGING;
  assert.equal((await post(valid, "wrong")).status, 401);
  foreign = true;
  assert.equal((await post()).status, 403);
  assert.equal(messages.length, 0);
});

test("the url must be the canonical tournament page (/casino/holdem/mtt/<id>); bad kinds / titles refused", async () => {
  for (const url of ["https://publicaccess.tv/p/lounge", "https://publicaccess.tv/casino/holdem/t/0123456789", "https://evil.invalid/casino/holdem/mtt/m012345678",
                     "http://publicaccess.tv/casino/holdem/mtt/m012345678", "https://publicaccess.tv/casino/holdem/mtt/m01234567"]) {
    assert.equal((await post({ ...valid, url })).status, 400, url);
  }
  for (const bad of [{ ...valid, kind: "spam" }, { ...valid, title: "" }, { ...valid, no: 0 }, null]) assert.equal((await post(bad)).status, 400);
  assert.equal((await post({ ...valid, url: "https://pa.tv/casino/holdem/mtt/m012345678" })).status, 200);
});

test("only the configured role, only on 'starting'; never @everyone / @here; escaped text", async () => {
  let r = await post();
  assert.equal(r.status, 200);
  assert.equal(messages[0].content, "<@&111111>");
  assert.deepEqual(messages[0].allowedMentions, { parse: [], users: [], roles: ["111111"], repliedUser: false });
  messages = [];
  r = await post({ ...valid, kind: "winner", winner: "Ann_[x](y)", role_id: "111111" });
  assert.equal(messages[0].content, "", "no ping on the winner post");
  assert.deepEqual(messages[0].allowedMentions.roles, []);
  assert.match(messages[0].embeds[0].description, /Ann\\_\\\[x\\\]\\\(y\\\) wins!/, "escaped");
  messages = [];
  await post({ ...valid, role_id: guildId });
  assert.equal(messages[0].content, "", "the guild id (@everyone) is never a role to ping");
  messages = [];
  await post({ ...valid, title: "@everyone free PAT **now**" });
  assert.equal(messages[0].content, "<@&111111>");
  assert.ok(!messages[0].embeds[0].title.includes("**"), "markdown escaped");
});

test("review: a 'starting' post reads 'Starting soon' before the start and 'Starting now' once it's due (the site posts it at the 15-minute mark, or at a start-now)", async () => {
  await post({ ...valid, start_at: Date.now() + 15 * 60e3 });
  assert.match(messages[0].embeds[0].title, /^🏆 Starting soon: #12 /);
  messages = [];
  await post({ ...valid, start_at: Date.now() - 1000 });
  assert.match(messages[0].embeds[0].title, /^🏆 Starting now: #12 /);
});
