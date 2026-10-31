"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
process.env.BOT_BRIDGE_PORT = "0"; process.env.BOT_BRIDGE_HOST = "127.0.0.1"; process.env.BOT_BRIDGE_SECRET = "fake-test-secret";
delete process.env.STAGING;
const guildId = "913269267691094026";
let messages = [], fail = false, foreign = false;
const roles = new Map([
  ["111111", { id: "111111", name: "boxing", mentionable: true }],
  ["222222", { id: "222222", name: "Movie Night", mentionable: true }],
  ["333333", { id: "333333", name: "staff", mentionable: false }],
  ["444444", { id: "444444", name: "duplicate", mentionable: true }],
  ["555555", { id: "555555", name: "duplicate", mentionable: true }],
  ["666666", { id: "666666", name: "here", mentionable: true }],
  [guildId, { id: guildId, name: "@everyone", mentionable: true }]
]);
const client = { channels: { fetch: async () => ({ guild: { id: foreign ? "other" : guildId, roles: { fetch: async () => roles } },
  isTextBased: () => true, send: async (m) => { if (fail) throw new Error("fake send failure"); messages.push(m); return { id: "message-id" }; } }) } };
let server, base;
const valid = { channel_id: "1206395925191200790", pad: { slug: "patv-lounge", title: "PATV Lounge" }, streamer: "Streamer", title: "Show title", kind: "stage", url: "https://publicaccess.tv/p/patv-lounge" };
async function post(body = valid, secret = "fake-test-secret") {
  const r = await fetch(base + "/stage/golive", { method: "POST", headers: { "Content-Type": "application/json", "X-Bot-Secret": secret }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
test.before(async () => { server = require("../discord-bot/botBridge").start(client); await new Promise((r) => server.once("listening", r)); base = "http://127.0.0.1:" + server.address().port; });
test.beforeEach(() => { messages = []; foreign = fail = false; });
test.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
test("secret, channel and foreign guild validation", async () => {
  assert.equal((await post(valid, "wrong")).status, 401);
  for (const channel_id of ["@on-air", "1234", 123456, "1".repeat(26)]) assert.equal((await post({ ...valid, channel_id })).status, 400);
  foreign = true; assert.equal((await post()).status, 403); assert.equal(messages.length, 0);
});
test("canonical HTTPS links only, including thumbnails", async () => {
  for (const url of ["http://publicaccess.tv/p/patv-lounge", "https://publicaccess.tv.evil.invalid/p/patv-lounge", "https://evil.invalid@publicaccess.tv/p/patv-lounge", "https://publicaccess.tv:8443/p/patv-lounge", "https://staging.publicaccess.tv/p/patv-lounge", "file:///x", "https://publicaccess.tv/p/private"]) {
    assert.equal((await post({ ...valid, url })).status, 400, url);
  }
  assert.equal((await post({ ...valid, thumb: "https://elsewhere.invalid/image.png" })).status, 400);
  assert.equal((await post({ ...valid, url: "https://pa.tv/p/patv-lounge" })).status, 200);
});
test("embed fields, truncation, safe default mentions and supported kinds", async () => {
  for (const kind of ["stage", "embed", "plex", "twitch"]) {
    const result = await post({ ...valid, kind, title: "x".repeat(250), thumb: "https://publicaccess.tv/thumb.png" });
    assert.deepEqual(result.body, { ok: true, id: "message-id" });
    const m = messages.at(-1);
    assert.equal(m.embeds[0].title, "🎥 Streamer is live on PATV Lounge");
    assert.equal(m.embeds[0].description.length, 200); assert.equal(m.embeds[0].url, valid.url);
    assert.deepEqual(m.embeds[0].footer, { text: "PATV stages" }); assert.equal(m.embeds[0].thumbnail.url, "https://publicaccess.tv/thumb.png");
    assert.deepEqual(m.allowedMentions, { parse: [], roles: [], users: [], repliedUser: false });
  }
  for (const bad of [null, {}, { ...valid, title: {} }, { ...valid, streamer: "" }, { ...valid, kind: "queue" }]) assert.equal((await post(bad)).status, 400);
});
test("titles and names are shown as escaped markdown: no masked links, headings or formatting", async () => {
  await post({ ...valid, streamer: "Players_Lounge1", title: "# [free PAT](https://evil.invalid) **now** @boxing" });
  const m = messages[0];
  assert.equal(m.embeds[0].title, "🎥 Players\\_Lounge1 is live on PATV Lounge");
  assert.equal(m.embeds[0].description, "\\# \\[free PAT\\]\\(https://evil.invalid\\) \\*\\*now\\*\\* @boxing");
  assert.equal(m.content, "<@&111111>", "the role tag still works");
});
test("any streamer can tag mentionable roles; quoted names, case, deduplication and unknown/ambiguous tags", async () => {
  await post({ ...valid, title: '@BOXING @boxing @"Movie Night" @staff @duplicate @unknown @everyone @here <@123456> <@&333333>' });
  const m = messages[0]; assert.equal(m.content, "<@&111111> <@&222222>");
  assert.deepEqual(m.allowedMentions, { parse: [], users: [], roles: ["111111", "222222"], repliedUser: false });
});
test("fixed role replaces title roles and cannot target everyone or a missing role", async () => {
  await post({ ...valid, title: "@boxing @everyone", role_id: "333333" });
  assert.equal(messages[0].content, "<@&333333>"); assert.deepEqual(messages[0].allowedMentions.roles, ["333333"]);
  for (const role_id of [guildId, "999999", "@everyone"]) assert.equal((await post({ ...valid, role_id })).status, 400);
});
test("test alerts are conspicuous with no pings; staging never sends; failures return an error", async () => {
  await post({ ...valid, test: true, role_id: "111111", title: "@boxing" });
  assert.match(messages[0].embeds[0].title, /TEST/); assert.equal(messages[0].content, ""); assert.deepEqual(messages[0].allowedMentions.roles, []);
  process.env.STAGING = "1";
  try { assert.equal((await post()).status, 409); } finally { delete process.env.STAGING; }
  assert.equal(messages.length, 1); fail = true; assert.equal((await post()).status, 500);
});
