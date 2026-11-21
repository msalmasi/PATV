// 1.99aou: the bots log a failed request as its status + answer only (errInfo), never the error object. An AxiosError
// carries its request config - the headers (X-Bot-Token, X-PATV-Key, Authorization) and the request body (a bot token in
// "password") - and console.error(error) prints all of it.
//   * every discord-bot/**/*.js, twitchbot/*.js and server.js: no console call with a bare error object (or its config /
//     request / headers) as an argument, no .catch(console.error);
//   * discord-bot/errinfo.js (the Discord bot's own copy - it loads no site file) gives the same line as processguard.js's
//     errInfo for every shape, and none of a request's credentials.
// Invented values only.
//   node --test test/discord-errinfo.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.resolve(__dirname, "..");
const { errInfo } = require("../discord-bot/errinfo");
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
  assert.match(discord, /const \{ errInfo \} = require\("\.\/errinfo"\)/);
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
