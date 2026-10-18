// 1.99acf the site's own bots send their caller key (R-11, docs/bot-keys.md): the Discord bot's backendAuth adds X-PATV-Key
// (PATV_KEY) to every axios request to BACKEND_BASE_URL's exact origin and to its /events streams - never another host or a
// look-alike, never in cleartext across a network (https, or loopback http), and a redirect off the site drops it - and
// keeps X-Bot-Token on the lookups; the Twitch bot does the same (twitchbot/patvAuth.js), its !spin fetch included; every
// fetch() to the site carries the key; requests to the site say which bot they are (User-Agent patv-discord-bot/1 /
// patv-twitch-bot/1 - the legacy-token counts on /admin/keys tell them apart); path parameters are encodeURIComponent()ed;
// the selfbot no longer borrows the site's TWITCH_BOT_TOKEN.
//   node --test test/bot-keys-callers.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "bot-keys-callers-test-")));   // botkeys.js opens ./myapp.db
process.env.BACKEND_BASE_URL = "https://publicaccess.tv";
process.env.DISCORD_BOT_TOKEN = "discord-token-for-tests";
process.env.TWITCH_BOT_TOKEN = "twitch-token-for-tests";
process.env.PATV_KEY = "discord.KEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKE";
const axios = require(require.resolve("axios", { paths: [path.join(repo, "discord-bot")] }));
const BA = require(path.join(repo, "discord-bot", "backendAuth"));
const TW = require(path.join(repo, "twitchbot", "patvAuth"));
const bk = require(path.join(repo, "botkeys"));

const sent = [];
const adapter = async (cfg) => { sent.push({ url: cfg.url, headers: JSON.parse(JSON.stringify(cfg.headers || {})), cfg }); return { data: {}, status: 200, statusText: "OK", headers: {}, config: cfg }; };
const hdr = (h, name) => { const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase()); return k ? h[k] : undefined; };

test("Discord bot: X-PATV-Key on every request to the site's exact origin, nowhere else; X-Bot-Token stays lookup-only", async () => {
  sent.length = 0;
  for (const url of ["https://publicaccess.tv/u/bob/chattip", "https://publicaccess.tv/api/users/discord/42", "https://publicaccess.tv/api/g/wheel/chatspin",
                     "https://publicaccess.tv.evil.example/api/x", "http://publicaccess.tv/api/x", "https://example.com/api/x", "https://publicaccess.tv:8443/api/x"]) {
    await axios.post(url, { password: "x" }, { adapter });
  }
  const [chattip, lookup, spin, evil, http, other, port] = sent.map((s) => s.headers);
  assert.equal(hdr(chattip, "X-PATV-Key"), process.env.PATV_KEY, "/chattip rides the interceptor");
  assert.equal(hdr(spin, "X-PATV-Key"), process.env.PATV_KEY);
  assert.equal(hdr(lookup, "X-PATV-Key"), process.env.PATV_KEY);
  assert.equal(hdr(lookup, "X-Bot-Token"), process.env.DISCORD_BOT_TOKEN, "the lookup token is unchanged");
  assert.equal(hdr(chattip, "X-Bot-Token"), undefined);
  for (const h of [evil, http, other, port]) assert.equal(hdr(h, "X-PATV-Key"), undefined, "exact origin only");
  assert.equal(hdr(chattip, "User-Agent"), "patv-discord-bot/1", "the site sees which bot it is");
  assert.notEqual(hdr(other, "User-Agent"), "patv-discord-bot/1", "...other hosts don't");
  assert.equal(bk.uaFamily(hdr(chattip, "User-Agent")), "patv-discord-bot/1", "the legacy hint keeps the bot's name");
  assert.deepEqual(BA.sseHeaders("https://publicaccess.tv/events?type=results&identifier=x"),
                   { headers: { "User-Agent": "patv-discord-bot/1", "X-PATV-Key": process.env.PATV_KEY } });
  assert.deepEqual(BA.sseHeaders("https://publicaccess.tv.evil.example/events"), {});
  assert.equal(BA.key(), process.env.PATV_KEY);
});

test("the key never crosses a network in cleartext, and a redirect off the site drops it", async () => {
  const saved = process.env.BACKEND_BASE_URL;
  try {
    process.env.BACKEND_BASE_URL = "http://publicaccess.tv";                 // a misconfigured plain-http site
    sent.length = 0;
    await axios.get("http://publicaccess.tv/api/x", { adapter });
    assert.equal(hdr(sent[0].headers, "X-PATV-Key"), undefined, "plain http to a remote host: no key");
    assert.equal(BA.siteHeaders("http://publicaccess.tv/events")["X-PATV-Key"], undefined);
    process.env.BACKEND_BASE_URL = "http://127.0.0.1:3000";                  // the bots beside the site on the VPS
    sent.length = 0;
    await axios.get("http://127.0.0.1:3000/api/x", { adapter });
    assert.equal(hdr(sent[0].headers, "X-PATV-Key"), process.env.PATV_KEY, "loopback http: the key");
    assert.equal(BA.sseHeaders("http://127.0.0.1:3000/events?type=spin").headers["X-PATV-Key"], process.env.PATV_KEY);
  } finally { process.env.BACKEND_BASE_URL = saved; }
  // follow-redirects' options for the next hop: off the site -> stripped (any case); on the site -> kept
  sent.length = 0;
  await axios.get("https://publicaccess.tv/api/r", { adapter });
  const before = sent[0].cfg.beforeRedirect;
  assert.equal(typeof before, "function", "every keyed request carries the redirect guard");
  const off = { href: "https://elsewhere.example/x", headers: { "X-PATV-Key": "k", "x-patv-key": "k", Accept: "a" } };
  before(off, {});
  assert.deepEqual(off.headers, { Accept: "a" }, "a hop to another origin loses the key");
  const on = { protocol: "https:", host: "publicaccess.tv", path: "/api/R", headers: { "X-PATV-Key": "k" } };
  before(on, {});
  assert.equal(on.headers["X-PATV-Key"], "k", "a hop within the site keeps it");
  let theirs = 0;
  sent.length = 0;
  await axios.get("https://publicaccess.tv/api/r", { adapter, beforeRedirect: () => { theirs++; } });
  sent[0].cfg.beforeRedirect({ href: "https://publicaccess.tv/x", headers: {} }, {});
  assert.equal(theirs, 1, "a caller's own beforeRedirect still runs");
});

test("Twitch bot (patvAuth.js): the same rules on its own axios, its streams and its !spin fetch", async () => {
  const ax = TW.install(axios.create());
  const tsent = [];
  const tad = async (cfg) => { tsent.push({ url: cfg.url, headers: JSON.parse(JSON.stringify(cfg.headers || {})), cfg }); return { data: {}, status: 200, statusText: "OK", headers: {}, config: cfg }; };
  process.env.PATV_KEY = "twitch.KEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKE";
  try {
    for (const url of ["https://publicaccess.tv/u/bob/chattip", "https://publicaccess.tv/api/users/twitch/1", "https://publicaccess.tv.evil.example/api/x", "https://example.com/x"]) {
      await ax.post(url, {}, { adapter: tad });
    }
    const [tip, lookup, evil, other] = tsent.map((s) => s.headers);
    assert.equal(hdr(tip, "X-PATV-Key"), process.env.PATV_KEY);
    assert.equal(hdr(tip, "User-Agent"), "patv-twitch-bot/1");
    assert.equal(hdr(lookup, "X-Bot-Token"), process.env.TWITCH_BOT_TOKEN);
    assert.equal(hdr(evil, "X-PATV-Key"), undefined);
    assert.equal(hdr(other, "X-PATV-Key"), undefined);
    assert.equal(typeof tsent[0].cfg.beforeRedirect, "function");
    const off = { href: "https://elsewhere.example/", headers: { "X-PATV-Key": "k" } };
    tsent[0].cfg.beforeRedirect(off, {});
    assert.equal(off.headers["X-PATV-Key"], undefined);
    assert.deepEqual(TW.siteHeaders("https://publicaccess.tv/api/g/wheel/chatspin"), { "User-Agent": "patv-twitch-bot/1", "X-PATV-Key": process.env.PATV_KEY });
    assert.equal(TW.patvSse("https://publicaccess.tv/events?type=spin&identifier=x").headers["X-PATV-Key"], process.env.PATV_KEY);
    assert.deepEqual(TW.siteHeaders("https://example.com/x"), {});
    assert.equal(bk.uaFamily("patv-twitch-bot/1"), "patv-twitch-bot/1");
  } finally { process.env.PATV_KEY = "discord.KEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKE"; }
});

test("R-11 review (SEC-1): a walked path ('.' / '..' segments, %2e, backslashes) gets neither the key nor the lookup token", async () => {
  const walked = ["https://publicaccess.tv/api/users/discord/../../pepe/control/pending", "https://publicaccess.tv/api/users/discord/%2e%2e/%2E%2E/pepe/control/pending",
                  "https://publicaccess.tv/api/users/discord/..%2F..%2Fpepe", "https://publicaccess.tv/api/users/discord/%252e%252e/x",
                  "https://publicaccess.tv/api/users/discord/a%5C..%5Cb", "https://publicaccess.tv/api/users/discord/."];
  for (const u of walked) assert.equal(BA.hasDotSegments(u) && TW.hasDotSegments(u), true, u);
  for (const u of ["https://publicaccess.tv/api/users/discord/42", "https://publicaccess.tv/api/u/...x/balance?next=../y", "https://publicaccess.tv/api/u/%25zz/x", "https://publicaccess.tv"]) {
    assert.equal(BA.hasDotSegments(u) || TW.hasDotSegments(u), false, u);
  }
  sent.length = 0;
  for (const u of walked) await axios.get(u, { adapter });
  for (const s of sent) {
    assert.equal(hdr(s.headers, "X-PATV-Key"), undefined, "Discord: no key on " + s.url);
    assert.equal(hdr(s.headers, "X-Bot-Token"), undefined, "Discord: no lookup token on " + s.url);
  }
  assert.equal(BA.siteHeaders(walked[0])["X-PATV-Key"], undefined, "fetch / EventSource headers too");
  const ax = TW.install(axios.create());
  const tsent = [];
  const tad = async (cfg) => { tsent.push({ url: cfg.url, headers: JSON.parse(JSON.stringify(cfg.headers || {})) }); return { data: {}, status: 200, statusText: "OK", headers: {}, config: cfg }; };
  process.env.PATV_KEY = "twitch.KEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKE";
  try {
    await ax.get("https://publicaccess.tv/api/users/twitch/displayname/../../../pepe/control/pending", { adapter: tad });
    await ax.get("https://publicaccess.tv/api/users/twitch/displayname/" + encodeURIComponent(".."), { adapter: tad });
    await ax.get("https://publicaccess.tv/api/users/twitch/displayname/bob", { adapter: tad });
    const [a, b, ok] = tsent.map((s) => s.headers);
    for (const h of [a, b]) { assert.equal(hdr(h, "X-PATV-Key"), undefined); assert.equal(hdr(h, "X-Bot-Token"), undefined); }
    assert.equal(hdr(ok, "X-PATV-Key"), process.env.PATV_KEY, "a real name keeps both");
    assert.equal(hdr(ok, "X-Bot-Token"), process.env.TWITCH_BOT_TOKEN);
    assert.equal(TW.siteHeaders("https://publicaccess.tv/api/u/../pepe/control/pending")["X-PATV-Key"], undefined);
    const hop = { href: "https://publicaccess.tv/api/x/../pepe/control/pending", headers: { "X-PATV-Key": "k" } };
    TW.stripOffSite(hop);
    assert.equal(hop.headers["X-PATV-Key"], undefined, "nor a redirect onto a walked path");
  } finally { process.env.PATV_KEY = "discord.KEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKE"; }
});

// every fetch( / new EventSource( call in the bots that targets the site carries the key headers
function botFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.name === "node_modules") continue;
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p); else if (f.name.endsWith(".js")) out.push(p);
    }
  };
  walk(dir);
  return out;
}
function siteCallsWithoutKey(dir) {
  const bad = [];
  for (const p of botFiles(dir)) {
    const src = fs.readFileSync(p, "utf8");
    const re = /(?<![.\w])(fetch|new EventSource)\(\s*([^,)]+)/g;
    let m;
    while ((m = re.exec(src))) {
      const arg = m[2].trim();
      const site = /BACKEND_BASE_URL/.test(arg) ||
        (/^\w+$/.test(arg) && new RegExp("(?:const|let|var)\\s+" + arg + "\\s*=\\s*process\\.env\\.BACKEND_BASE_URL").test(src));
      if (!site) continue;
      const call = src.slice(m.index, m.index + 400);
      if (!/siteHeaders\(|sseHeaders\(|patvSse\(|X-PATV-Key/.test(call)) bad.push(path.relative(repo, p) + ": " + call.split("\n")[0].trim());
    }
  }
  return bad;
}

test("every fetch() / EventSource to the site carries the key; path parameters are encoded", () => {
  const bad = [...siteCallsWithoutKey(path.join(repo, "twitchbot")), ...siteCallsWithoutKey(path.join(repo, "discord-bot"))];
  assert.deepEqual(bad, [], "a fetch / EventSource to BACKEND_BASE_URL without X-PATV-Key");
  const tw = fs.readFileSync(path.join(repo, "twitchbot", "twitch.js"), "utf8");
  assert.match(tw, /fetch\(url, \{[\s\S]{0,200}siteHeaders\(url\)/, "the !spin chatspin fetch");
  // a chat-supplied name can't walk to another route (axios normalises ../)
  for (const f of [...botFiles(path.join(repo, "twitchbot")), ...botFiles(path.join(repo, "discord-bot"))]) {
    const src = fs.readFileSync(f, "utf8");
    const raw = src.match(/BACKEND_BASE_URL\s*\+\s*`[^`]*\$\{(?!encodeURIComponent\()[^}]+\}[^`]*`/g) || [];
    assert.deepEqual(raw, [], path.relative(repo, f) + ": a path parameter without encodeURIComponent");
  }
  assert.match(tw, /\/api\/users\/twitch\/displayname\/\$\{encodeURIComponent\(cleanRecipientDisplayName\)\}/, "!tip's recipient name");
});

test("the Discord /spin and Twitch streams pass the key; the selfbot never reads the site's TWITCH_BOT_TOKEN", () => {
  const spin = fs.readFileSync(path.join(repo, "discord-bot", "commands", "spin.js"), "utf8");
  assert.equal((spin.match(/new EventSource\((\w+), sseHeaders\(\1\)\)/g) || []).length, 2);
  const tw = fs.readFileSync(path.join(repo, "twitchbot", "twitch.js"), "utf8");
  assert.equal((tw.match(/new EventSource\((\w+), patvSse\(\1\)\)/g) || []).length, 2);
  assert.match(tw, /require\("\.\/patvAuth"\)/);
  assert.match(tw, /patvAuth\.install\(axios\)/);
  const pa = fs.readFileSync(path.join(repo, "twitchbot", "patvAuth.js"), "utf8");
  assert.match(pa, /new URL\(String\(url\)\)\.origin === new URL\(String\(process\.env\.BACKEND_BASE_URL \|\| ""\)\)\.origin/, "exact origin");
  const self = fs.readFileSync(path.join(repo, "discordself", "discordbot.js"), "utf8");
  assert.ok(!/TWITCH_BOT_TOKEN'\)/.test(self) && !/readEnvKey\([^)]*'TWITCH_BOT_TOKEN'/.test(self), "no fallback to the site's shared token");
});
