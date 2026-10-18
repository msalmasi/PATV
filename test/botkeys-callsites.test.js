// 1.99acf botkeys.js (R-11): every bot-token check goes through isBotToken() / isPlatformBot(), so a key caller is accepted
// everywhere and every use of the shared tokens is counted. A tree scan (like tx-global.test.js):
//   * no comparison with process.env.TWITCH_BOT_TOKEN / DISCORD_BOT_TOKEN outside botkeys.js (12 of them were converted)
//   * no bot route uses multer: the key's request context lives in AsyncLocalStorage, which multer loses - the multer
//     routes are a member's avatar upload and the admin badge form
//   node --test test/botkeys-callsites.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const SKIP = new Set(["node_modules", "test", "public", ".git", "camfrog-bot", "uploads", "data", "backups"]);
function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.js$/.test(e.name) && !/\.min\.js$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(repo);

test("no direct comparison with the shared bot tokens outside botkeys.js", () => {
  const CMP = /(?:===|!==|==|!=)\s*process\.env\.(?:TWITCH|DISCORD)_BOT_TOKEN\b|process\.env\.(?:TWITCH|DISCORD)_BOT_TOKEN\s*(?:===|!==|==|!=)/;
  const bad = [];
  for (const f of files) {
    if (path.basename(f) === "botkeys.js") continue;
    fs.readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => { if (CMP.test(line)) bad.push(`${path.relative(repo, f)}:${i + 1}`); });
  }
  assert.deepEqual(bad, [], "use isBotToken() / isPlatformBot() (botkeys.js) instead:\n" + bad.join("\n"));
  assert.ok(files.length > 100, "the scan saw the tree");
});

test("index.js keeps isBotToken / isPlatformBot as thin wrappers over botkeys.js, mounted after the body parsers", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.match(src, /function isBotToken\(token\) \{\s*return botkeys\.isBotToken\(token\);\s*\}/);
  assert.match(src, /function isPlatformBot\(token\) \{\s*return botkeys\.isPlatformBot\(token\);\s*\}/);
  const parsers = src.indexOf("app.use(express.urlencoded(");
  const mw = src.indexOf("app.use(botkeys.middleware)");
  assert.ok(parsers > 0 && mw > parsers, "the middleware runs after the global body parsers");
  for (const f of ["shop.js", "user.controller.js"]) {
    assert.match(fs.readFileSync(path.join(repo, f), "utf8"), /require\(["']\.\/botkeys["']\)\.isBotToken\(password\)/, f);
  }
});

test("no bot route uses multer (the request context would be lost)", () => {
  // a member's own avatar upload and the admin badge form (cookie auth, never a bot)
  const ALLOW = new Set(["/api/u/:username/update/avatar", "/api/badges/add"]);
  const bad = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/\bupload\.(single|array|fields|none|any)\(/.test(line)) return;
      const ctx = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
      const m = ctx.match(/["'`](\/[^"'`]+)["'`]/g);
      const route = m ? m[m.length - 1].slice(1, -1) : "?";
      if (!ALLOW.has(route)) bad.push(`${path.relative(repo, f)}:${i + 1} ${route}`);
    });
  }
  assert.deepEqual(bad, [], "a multer route outside the allow-list:\n" + bad.join("\n"));
  const users = files.filter((f) => /require\(["']multer["']\)/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(repo, f)).sort();
  assert.deepEqual(users, ["index.js", "user.controller.js"], "multer is loaded only where it always was");
});
