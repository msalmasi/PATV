// 1.99aou: the bots log a failed request as its status + answer only (errInfo), never the error object. An AxiosError
// carries its request config - the headers (X-Bot-Token, X-PATV-Key, Authorization) and the request body (a bot token in
// "password") - and console.error(error) prints all of it.
//   * every discord-bot/**/*.js, blackjack/*.js, twitchbot/*.js and server.js: no console call with a bare error object (or
//     its config / request / headers) as an argument, no .catch(console.error);
//   * discord-bot/errinfo.js (the Discord bot's own copy - it loads no site file) gives the same line as processguard.js's
//     errInfo for every shape, and none of a request's credentials;
//   * its guardProcess: an unhandled rejection (a real AxiosError nobody awaited, in a child process) is one errInfo line and
//     the bot keeps running; an uncaught exception is one errInfo line and exit 1 - never the headers. discord.js and
//     blackjack.js install it first thing, and discord.js's un-awaited jobs (the raffle draw, the level-up bonuses, a
//     cash-out), the /shop menu, a /shop pick's prize lookup and /spin's stream handlers catch their own failures.
// Invented values only.
//   node --test test/discord-errinfo.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.resolve(__dirname, "..");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { errInfo, guardProcess } = require("../discord-bot/errinfo");
const PG = require("../processguard");

const BARE = /^(?:error|err|e|ex)$/;                        // an error object passed whole
const PART = /^(?:error|err|e|ex)\.(?:config|request|headers|toJSON)\b/; // the parts that hold the request's credentials

/** The JS files the bots run (no node_modules). */
function botFiles() {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(path.join(repo, dir), { withFileTypes: true })) {
      if (ent.name === "node_modules") continue;
      const rel = dir + "/" + ent.name;
      if (ent.isDirectory()) walk(rel);
      else if (ent.name.endsWith(".js")) out.push(rel);
    }
  };
  walk("discord-bot");
  walk("blackjack");
  walk("twitchbot");
  out.push("server.js");
  return out;
}

/** The argument text of the call whose "(" is at src[open]: balanced brackets, strings and comments skipped. */
function argsAt(src, open) {
  let depth = 0, i = open, quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2) + 1; if (i <= 0) break; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(open + 1, i);
}

/** True when src[at] sits in a comment ("//" earlier on its line, a "*" comment line, or inside a block comment). */
function inComment(src, at) {
  const line = src.slice(src.lastIndexOf("\n", at - 1) + 1, at);
  if (line.includes("//") || /^\s*\*/.test(line)) return true;
  const open = src.lastIndexOf("/*", at), close = src.lastIndexOf("*/", at);
  return open >= 0 && open > close;
}

/** Every console call's arguments in src -> [{line, args}] (calls written in comments are skipped). */
function consoleCalls(src) {
  const out = [];
  for (const m of src.matchAll(/console\.(?:error|warn|log|info|debug)\(/g)) {
    if (inComment(src, m.index)) continue;
    out.push({ line: src.slice(0, m.index).split("\n").length, args: splitArgs(argsAt(src, m.index + m[0].length - 1)) });
  }
  return out;
}

/** Top-level comma-separated arguments, trimmed. */
function splitArgs(text) {
  const out = [];
  let depth = 0, quote = null, cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    cur += c;
    if (quote) {
      if (c === "\\") { cur += text[++i] || ""; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { out.push(cur.slice(0, -1).trim()); cur = ""; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

test("the scanner sees what it is meant to see", () => {
  const sample = 'console.error("x:", error);\nconsole.error(\n  "y",\n  err\n);\nconsole.warn(`a ${b}`, errInfo(e));\n' +
    "p.catch(console.error);\nconsole.log(e.config);\n// console.error(error) in a comment\n/* console.error(e) */\n" +
    'console.log("a, b", { e }, f(e, err));\n';
  const found = consoleCalls(sample).filter((c) => c.args.some((a) => BARE.test(a) || PART.test(a)))
    .map((c) => c.line + ": " + c.args.join(" | "));
  assert.deepEqual(found, ['1: "x:" | error', '2: "y" | err', "8: e.config"]);
  assert.match(sample, /\.catch\(\s*console\.(?:error|warn|log)\s*\)/);
});

test("no bot file logs a whole error object, its config, request or headers", () => {
  const files = botFiles();
  assert.ok(files.includes("discord-bot/discord.js") && files.includes("discord-bot/commands/shop.js") &&
            files.includes("blackjack/blackjack.js") &&
            files.includes("twitchbot/channelpoints.js") && files.includes("server.js"), files.join(" "));
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(repo, f), "utf8");
    for (const c of consoleCalls(src)) {
      if (c.args.some((a) => BARE.test(a) || PART.test(a))) bad.push(`${f}:${c.line}: ${c.args.join(", ")}`);
    }
    if (/\.catch\(\s*console\.(?:error|warn|log|info)\s*\)/.test(src)) bad.push(`${f}: .catch(console.*)`);
  }
  assert.deepEqual(bad, []);
});

test("the Discord bot loads its own errinfo.js, not the site's files", () => {
  const discord = fs.readFileSync(path.join(repo, "discord-bot", "discord.js"), "utf8");
  assert.match(discord, /const \{ errInfo, guardProcess \} = require\("\.\/errinfo"\)/);
  for (const f of botFiles().filter((x) => x.startsWith("discord-bot/"))) {
    const src = fs.readFileSync(path.join(repo, f), "utf8");
    assert.doesNotMatch(src, /require\(\s*["']\.\.\/(?:\.\.\/)?(?:twitchbot|processguard|errorhandler)/, f);
  }
});

// An AxiosError-shaped object: the request's credentials in its config, the answer in its response.
function axiosLike(response) {
  return {
    name: "AxiosError", code: "ERR_BAD_RESPONSE", message: "Request failed with status code 500",
    config: { url: "http://127.0.0.1:1/api/test", headers: { "X-PATV-Key": "test-key-not-real", "X-Bot-Token": "test-token-not-real",
      Authorization: "Bearer test-token-not-real" }, data: JSON.stringify({ password: "test-token-not-real" }) },
    request: { _header: "POST /api/test HTTP/1.1\r\nX-Bot-Token: test-token-not-real\r\n" },
    response,
  };
}

test("errInfo: the status and the answer only - the same line as processguard's errInfo", () => {
  const cases = [
    axiosLike({ status: 500, data: { message: "test failure" }, headers: { "set-cookie": "test-cookie" } }),
    axiosLike({ status: 403, data: "unauthorized" }),
    axiosLike({ status: 502, data: "" }),
    axiosLike({ status: 500, data: "x".repeat(1000) }),
    (() => { const circular = { a: 1 }; circular.self = circular; return axiosLike({ status: 500, data: circular }); })(),
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED",
      config: { headers: { "X-PATV-Key": "test-key-not-real" } } }),
    Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }),
    Object.assign(new Error("x".repeat(1000)), { code: "E_LONG" }),
    new Error(""),
    { response: null, message: "no response" },
    "a plain string",
    null,
    undefined,
    42,
  ];
  for (const e of cases) {
    const line = errInfo(e);
    assert.equal(typeof line, "string");
    assert.equal(line, PG.errInfo(e), "the same as processguard.errInfo for " + String(e && e.message || e));
    assert.doesNotMatch(line, /test-key|test-token|test-cookie|headers|password|Authorization|X-Bot-Token|X-PATV-Key/);
    assert.ok(line.length <= 300 + 140, "bounded: " + line.length);
  }
  assert.equal(errInfo(cases[0]), 'HTTP 500 {"message":"test failure"}');
  assert.equal(errInfo(cases[1]), "HTTP 403 unauthorized");
  assert.equal(errInfo(cases[2]), "HTTP 502");
  assert.equal(errInfo(cases[3]), "HTTP 500 " + "x".repeat(300));
  assert.equal(errInfo(cases[4]), "HTTP 500 [unreadable]");
  assert.equal(errInfo(cases[5]), "ECONNREFUSED connect ECONNREFUSED 127.0.0.1:1");
  assert.equal(errInfo(cases[6]), "fetch failed (cause: UND_ERR_SOCKET other side closed)");
  assert.equal(errInfo(cases[8]), "error");
});

// Invented values only: what an AxiosError's config would carry.
const KEY = "test-key-not-real-" + "k".repeat(20), TOKEN = "test-token-not-real-" + "t".repeat(20);

test("guardProcess: an unhandled rejection is one errInfo line and the process keeps running; an exception exits 1", () => {
  const proc = new EventEmitter();
  const lines = [], exits = [];
  assert.equal(guardProcess(proc, "discord", { log: (l) => lines.push(l), exit: (c) => exits.push(c) }), proc);
  guardProcess(proc, "discord", { log: (l) => lines.push("second " + l) });        // installed once per process
  assert.equal(proc.listenerCount("unhandledRejection"), 1);
  assert.equal(proc.listenerCount("uncaughtException"), 1);
  proc.emit("unhandledRejection", axiosLike({ status: 500, data: { message: "test failure" } }));
  assert.deepEqual(lines, ['[discord] unhandled rejection (kept running): HTTP 500 {"message":"test failure"}']);
  assert.deepEqual(exits, [], "a rejection keeps the bot running");
  proc.emit("uncaughtException", Object.assign(new Error("test crash"), { config: { headers: { "X-PATV-Key": KEY } } }));
  assert.deepEqual(lines.slice(1), ["[discord] uncaught exception: test crash"]);
  assert.deepEqual(exits, [1], "an uncaught exception exits 1, as Node would");
  const quiet = new EventEmitter();
  guardProcess(quiet, "x", { log: () => { throw new Error("log down"); }, exit: () => {} });
  assert.doesNotThrow(() => quiet.emit("unhandledRejection", null), "the handlers never throw");
  assert.doesNotMatch(lines.join("\n"), /test-key|test-token|X-PATV-Key|X-Bot-Token|headers/);
});

/** Run `body` in a child node (the repo as its cwd) with the guard installed and a loopback site answering 500. */
function child(body) {
  const script = `
    "use strict";
    const http = require("http");
    require("./discord-bot/errinfo").guardProcess(process, "discord");
    const axios = require("axios");
    const KEY = ${JSON.stringify(KEY)}, TOKEN = ${JSON.stringify(TOKEN)};
    setTimeout(() => { console.log("timed out"); process.exit(3); }, 8000).unref();
    const site = http.createServer((q, r) => { r.writeHead(500, { "content-type": "application/json" }); r.end('{"message":"test failure"}'); });
    site.listen(0, "127.0.0.1", () => {
      const url = "http://127.0.0.1:" + site.address().port + "/api/users/discord/1";
      ${body}
    });`;
  const r = spawnSync(process.execPath, ["-e", script], { cwd: repo, encoding: "utf8", timeout: 20000,
    env: Object.assign({}, process.env, { NODE_OPTIONS: "" }) });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

test("a real AxiosError nobody awaited: one errInfo line, never the request's headers, and the bot keeps running", () => {
  const { code, out } = child(`
      process.on("unhandledRejection", () => setTimeout(() => { console.log("still running"); site.close(); process.exit(0); }, 50));
      axios.get(url, { headers: { "X-Bot-Token": TOKEN, "X-PATV-Key": KEY } });   // not awaited, no catch`);
  assert.equal(code, 0, out);
  assert.match(out, /\[discord\] unhandled rejection \(kept running\): HTTP 500 \{"message":"test failure"\}/);
  assert.match(out, /still running/);
  assert.doesNotMatch(out, /test-key|test-token|AxiosError|X-PATV-Key|X-Bot-Token/i, "no header, no error dump");
});

test("an uncaught exception carrying a request: one errInfo line and exit 1, never the headers", () => {
  const { code, out } = child(`
      axios.get(url, { headers: { "X-Bot-Token": TOKEN, "X-PATV-Key": KEY } }).catch((e) => { setTimeout(() => { throw e; }); });`);
  assert.equal(code, 1, out);
  assert.match(out, /\[discord\] uncaught exception: HTTP 500 \{"message":"test failure"\}/);
  assert.doesNotMatch(out, /test-key|test-token|AxiosError|X-PATV-Key|X-Bot-Token/i, "no header, no error dump");
});

test("discord.js and blackjack.js install the guard first; discord.js's un-awaited jobs and handlers catch their failures", () => {
  const read = (f) => fs.readFileSync(path.join(repo, f), "utf8").replace(/\r\n/g, "\n");
  const discord = read("discord-bot/discord.js"), blackjack = read("blackjack/blackjack.js");
  const at = (src, re) => { const m = re.exec(src); return m ? m.index : -1; };
  for (const [name, src, label] of [["discord.js", discord, "discord"], ["blackjack.js", blackjack, "blackjack"]]) {
    const g = at(src, new RegExp(`\\nguardProcess\\(process, "${label}"\\);`));
    assert.ok(g > 0, `${name} installs guardProcess(process, "${label}")`);
    const login = at(src, /\nclient\.login\(/);
    assert.ok(login < 0 || g < login, `${name}: before the client logs in`);
    assert.ok(g < at(src, /require\("(?:\.\.\/discord-bot|\.)\/userUtils"\)/), `${name}: before userUtils / backendAuth load`);
  }
  // every statement that starts one of discord.js's own async jobs without awaiting it ends in a .catch
  const jobs = [...discord.matchAll(/^[ \t]*(endRaffle|addLevelUpBonus|addLevelUpXpBonus|processCashout)\([^;]*;/gm)];
  assert.deepEqual(jobs.map((m) => m[1]), ["endRaffle", "addLevelUpBonus", "addLevelUpXpBonus", "processCashout"],
    "the raffle draw, the two level-up bonuses and the cash-out");
  for (const m of jobs) assert.match(m[0], /\.catch\(/, "not awaited, so caught: " + m[0].trim().slice(0, 80));
  assert.match(discord, /async function onChatMessage\(message\) \{[\s\S]{0,300}?\n  try \{/, "onChatMessage: one try");
  assert.match(discord, /try \{\n\s*winnerBalance = await findUserBalance\(winnerId\);/, "the draw's balance lookup is in the try");
  assert.match(discord, /try \{\n\s*await shopCommand\.handleSelectMenu\(interaction\);\n\s*\} catch \(error\) \{/,
    "the /shop menu listener catches");
  assert.match(discord, /try \{\n\s*const discordUser = await findOrCreateDiscordUser\(discordId, displayName, avatar\);/,
    "the PokerNow game's account lookup is in the try");
  const shop = read("discord-bot/commands/shop.js");
  assert.doesNotMatch(shop, /const selectedPrizeName = await getPrizeDetails/);
  assert.match(shop, /try \{\n(?:[^\n]*\n){0,3}\s*selectedPrizeName = await getPrizeDetails\(selectedPrizeId\);/,
    "a /shop pick's prize lookup is in the try");
  const spin = read("discord-bot/commands/spin.js");
  assert.equal((spin.match(/onmessage = async function \(event\) \{[^\n]*\n\s*try \{/g) || []).length, 2,
    "both /spin stream handlers' bodies are in a try");
});
