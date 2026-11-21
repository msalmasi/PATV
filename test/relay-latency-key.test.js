// 1.99aou: tools/relay-latency.js authenticates with the ops key from the environment (OPS_PATV_KEY -> X-PATV-Key) and,
// while TWITCH_BOT_TOKEN is set, the legacy token in the body too (as every bot does until the legacy branch is deleted:
// a key that doesn't resolve is judged on the token). Never from the command line: a --key argument is ignored. The key
// and the token go only over https or to loopback (--base), and a redirect is never followed. Invented values only; the
// tool's post() runs in a vm with a fake fetch (no network).
//   node --test test/relay-latency-key.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../tools/relay-latency.js"), "utf8");
const KEY = "ops." + "k".repeat(43);                      // shaped like a key, never minted
const TOKEN = "test-token-not-real";

/** The tool's setup + post() with this argv / env; -> { sent: [{url, options}], exited } after one post. */
async function postWith(argv, env) {
  const sent = [];
  let exited = null;
  const context = {
    require: () => ({ config() {} }),                      // dotenv: nothing from a file
    process: { argv: ["node", "relay-latency.js", ...argv], env, exit(code) { exited = code; throw new Error("exit " + code); } },
    console: { error() {}, log() {} },
    fetch: async (url, options) => { sent.push({ url, options }); return { status: 200, json: async () => ({}) }; },
  };
  try {
    vm.runInNewContext(source.slice(0, source.indexOf("const sleep =")) + "\nthis.post = post;", context);
  } catch (e) {
    if (exited === null) throw e;
    return { sent, exited };
  }
  await context.post("/api/bridge/test/say", { slug: "test-pad", text: "test line" });
  return { sent, exited };
}

const ARGS = ["--slug", "test-pad", "--login", "test-login"];

test("with OPS_PATV_KEY: the key goes in X-PATV-Key, and the legacy token in the body while it is set", async () => {
  const { sent } = await postWith(ARGS, { OPS_PATV_KEY: KEY, TWITCH_BOT_TOKEN: TOKEN });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.headers["X-PATV-Key"], KEY);
  const body = JSON.parse(sent[0].options.body);
  assert.equal(body.password, TOKEN, "the token too, until the legacy branch is deleted (a key that doesn't resolve falls back to it)");
  assert.equal(body.text, "test line");
  assert.ok(!sent[0].url.includes(KEY) && !sent[0].url.includes(TOKEN), "nothing secret in the URL");
  const keyOnly = await postWith(ARGS, { OPS_PATV_KEY: KEY });
  assert.equal(keyOnly.sent[0].options.headers["X-PATV-Key"], KEY);
  assert.equal(JSON.parse(keyOnly.sent[0].options.body).password, undefined, "no token set: none in the body");
});

test("never follows a redirect (fetch would keep X-PATV-Key on one to another host)", async () => {
  for (const env of [{ OPS_PATV_KEY: KEY }, { TWITCH_BOT_TOKEN: TOKEN }]) {
    const { sent } = await postWith(ARGS, env);
    assert.equal(sent[0].options.redirect, "error");
  }
  assert.equal((source.match(/fetch\(/g) || []).length, (source.match(/redirect: "error"/g) || []).length,
    "every fetch in the tool says redirect: \"error\"");
});

test("--base: the key and the token only over https or to loopback", async () => {
  const env = { OPS_PATV_KEY: KEY, TWITCH_BOT_TOKEN: TOKEN };
  for (const base of ["https://staging.example.test", "http://127.0.0.1:3100", "http://localhost:3100", "http://[::1]:3100",
                      "http://127.0.0.1", "https://staging.example.test/"]) {
    const { sent, exited } = await postWith([...ARGS, "--base", base], env);
    assert.equal(exited, null, base);
    assert.equal(sent.length, 1, base);
    assert.ok(sent[0].url.startsWith(base.replace(/\/+$/, "") + "/api/"), sent[0].url);
  }
  for (const base of ["http://staging.example.test", "http://192.0.2.1:3100", "ftp://127.0.0.1", "http://127.0.0.1.example.test",
                      "http://localhost.example.test:3100", "http://127.0.0.1@example.test", "https://", "127.0.0.1:3100"]) {
    for (const e of [env, { TWITCH_BOT_TOKEN: TOKEN }, { OPS_PATV_KEY: KEY }]) {
      const { sent, exited } = await postWith([...ARGS, "--base", base], e);
      assert.equal(exited, 2, "refused: " + base);
      assert.equal(sent.length, 0, "nothing sent to " + base);
    }
  }
  const { sent } = await postWith(ARGS, env);
  assert.ok(sent[0].url.startsWith("http://127.0.0.1:3100/"), "the default is the site's own loopback port");
});

test("without a key: the legacy token in the body (the fallback), no key header", async () => {
  for (const env of [{ TWITCH_BOT_TOKEN: TOKEN }, { OPS_PATV_KEY: "", TWITCH_BOT_TOKEN: TOKEN }]) {
    const { sent } = await postWith(ARGS, env);
    assert.equal(sent[0].options.headers["X-PATV-Key"], undefined);
    const body = JSON.parse(sent[0].options.body);
    assert.equal(body.password, TOKEN);
    assert.equal(body.text, "test line");
  }
});

test("never from the command line: --key is ignored, and with no credential in the environment it stops", async () => {
  const withKeyArg = await postWith([...ARGS, "--key", KEY], { TWITCH_BOT_TOKEN: TOKEN });
  assert.equal(withKeyArg.sent[0].options.headers["X-PATV-Key"], undefined, "a --key argument never becomes the header");
  assert.ok(!withKeyArg.sent[0].options.body.includes(KEY), "nor goes in the body");
  const none = await postWith([...ARGS, "--key", KEY], {});
  assert.equal(none.exited, 2, "no OPS_PATV_KEY and no TWITCH_BOT_TOKEN in the environment: usage, exit 2");
  assert.equal(none.sent.length, 0, "nothing sent");
  assert.doesNotMatch(source, /args\.(key|token|password)\b/, "the tool reads no credential from argv");
});
