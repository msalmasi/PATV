// The Discord bot's bridge (discord-bot/botBridge.js) checks X-Bot-Secret in constant time: validSecret hashes both
// sides to 32-byte SHA-256 digests and compares them with crypto.timingSafeEqual, so the buffers always have the same
// length. A wrong, short, long, prefixed, empty, missing or non-string secret is refused and never throws; the right one
// gets through to the handlers; with no secret configured everything is refused; a GET is still a 405.
//   node --test test/bot-bridge-secret.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const bridge = require("../discord-bot/botBridge");
const { validSecret } = bridge;

// Invented values only.
const SECRET = "test-bridge-secret-not-real";
const WIDE = "test-蘑菇-not-real";                      // multi-byte (UTF-8: 3 bytes per CJK character)

// Every value that must be refused next to SECRET (all strings, so they also go through the HTTP header).
const WRONG = [
  SECRET.slice(0, -1) + "X",                             // same length, last character changed
  SECRET.slice(0, -1),                                   // a prefix (shorter)
  SECRET + "x",                                          // the secret plus a suffix (longer)
  "x",                                                   // one character
  SECRET.toUpperCase(),                                  // case matters
];

test("validSecret: the configured secret only", () => {
  assert.equal(validSecret(SECRET, SECRET), true);
  for (const supplied of WRONG) assert.equal(validSecret(SECRET, supplied), false, `refused: ${supplied.length} chars`);
});

test("validSecret: empty, missing and non-string values are refused without throwing", () => {
  assert.equal(validSecret(SECRET, ""), false, "empty supplied");
  assert.equal(validSecret(SECRET, undefined), false, "missing (undefined)");
  assert.equal(validSecret(SECRET, null), false, "missing (null)");
  assert.equal(validSecret(SECRET, [SECRET]), false, "an array (a repeated header) is not a string");
  assert.equal(validSecret(SECRET, 123), false, "a number is not a string");
});

test("validSecret: an empty or unset configured secret refuses everything", () => {
  assert.equal(validSecret("", ""), false);
  assert.equal(validSecret("", "anything"), false);
  assert.equal(validSecret("", SECRET), false);
  assert.equal(validSecret(undefined, SECRET), false);
  assert.equal(validSecret(undefined, undefined), false);
  assert.equal(validSecret(null, ""), false);
});

test("validSecret: multi-byte secrets compare by their bytes", () => {
  assert.equal(validSecret(WIDE, WIDE), true);
  assert.equal(validSecret(WIDE, "test-蘑菈-not-real"), false, "one character changed (same byte length)");
  assert.equal(validSecret(WIDE, "test-蘑x-not-real"), false, "same string length, different byte length");
  assert.equal(validSecret(WIDE, "test-蘑菇-not-rea"), false, "a prefix");
  assert.equal(validSecret(WIDE, SECRET), false);
});

// A Discord client stub with just what /store/role-members touches.
const client = {
  channels: {
    fetch: async () => ({
      guild: {
        members: { fetch: async () => {} },
        roles: { cache: [{ name: "Scout", members: { map: (fn) => [{ id: "111" }, { id: "222" }].map(fn) } }] },
      },
    }),
  },
};

// start() reads BOT_BRIDGE_* when it is called: set them for the call, then put the environment back.
async function startBridge(secret) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(BOT|POKER)_BRIDGE_/.test(k)) delete process.env[k];
  process.env.BOT_BRIDGE_HOST = "127.0.0.1";
  process.env.BOT_BRIDGE_PORT = "0";                       // any free loopback port
  if (secret !== undefined) process.env.BOT_BRIDGE_SECRET = secret;
  const warn = console.warn;
  console.warn = () => {};                                 // the "not set" warning is expected for the no-secret server
  let server;
  try {
    server = bridge.start(client);
    if (!server.listening) await once(server, "listening");
  } finally {
    console.warn = warn;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  return server;
}

async function stopBridge(server) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}

function call(server, { method = "POST", path = "/store/role-members", headers = {}, body = { role: "scout" } } = {}) {
  return new Promise((resolve, reject) => {
    const data = method === "POST" ? JSON.stringify(body) : "";
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("the bridge: the right secret reaches the handler, anything else is a 401, GET is a 405", async () => {
  let server;
  try {
    server = await startBridge(SECRET);
    const ok = await call(server, { headers: { "X-Bot-Secret": SECRET } });
    assert.equal(ok.status, 200, "the real /store/role-members path answers");
    assert.deepEqual(ok.json, { role: "Scout", discordIds: ["111", "222"] });
    assert.equal((await call(server, { path: "/no-such-path", headers: { "x-bot-secret": SECRET } })).status, 404,
      "the secret passed, unknown path");
    for (const bad of [...WRONG, ""]) {
      const r = await call(server, { headers: { "X-Bot-Secret": bad } });
      assert.equal(r.status, 401, `refused: ${bad.length} chars`);
      assert.deepEqual(r.json, { error: "unauthorized" });
    }
    const none = await call(server, {});
    assert.equal(none.status, 401, "no header");
    assert.deepEqual(none.json, { error: "unauthorized" });
    assert.equal((await call(server, { method: "GET", headers: { "X-Bot-Secret": SECRET } })).status, 405);
  } finally { await stopBridge(server); }
});

test("the bridge with no secret configured refuses everything", async () => {
  for (const configured of [undefined, ""]) {
    let server;
    try {
      server = await startBridge(configured);
      assert.equal((await call(server, {})).status, 401, "no header");
      assert.equal((await call(server, { headers: { "X-Bot-Secret": "" } })).status, 401, "an empty header");
      assert.equal((await call(server, { headers: { "X-Bot-Secret": "anything" } })).status, 401, "any value");
    } finally { await stopBridge(server); }
  }
});
