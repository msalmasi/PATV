// 1.99ads (S1 Q5b): tools/hubseam-driver.js's identity and looks commands (seam-contract.md "Driver commands S1 adds") drive
// v1's real modules on a throwaway database: link / unlink / moveLogin / merge / cosmetic / textStyle write what the identity
// and looks topics read, and `looks` answers like POST /internal/v1/looks.
//   node --test test/hubseam-driver-s1.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const NS = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";

function driver() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubseam-driver-s1-"));
  const env = { ...process.env, HUB_V1_ENV: "test", CHAT_GENESIS_NS: NS };
  for (const k of ["HUB_V1_URL", "HUB_V1_KEY", "HUB_V1_KEY_ID", "STAGING", "SITE_URL", "PUBLIC_BASE_URL"]) delete env[k];
  const p = spawn(process.execPath, [path.join(repo, "tools", "hubseam-driver.js"), "--dir", dir], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", n = 0;
  const waiting = new Map();
  p.stdout.on("data", (c) => {
    buf += c.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = JSON.parse(line);
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    }
  });
  p.stderr.on("data", () => {});
  const call = (cmd, args = {}) => new Promise((resolve, reject) => {
    const id = ++n;
    waiting.set(id, (m) => (m.ok ? resolve(m.result) : reject(new Error(m.error))));
    p.stdin.write(JSON.stringify({ id, cmd, args }) + "\n");
  });
  const close = () => new Promise((r) => { p.on("exit", r); p.stdin.end(); });
  return { call, close };
}

test("the S1 identity / looks driver commands", { timeout: 120000 }, async () => {
  const d = driver();
  try {
    await d.call("switches", { set: { identity: true, looks: true } });
    const { acct } = await d.call("account", { user: "d1", login: "Dee" });
    const { acct: acct2 } = await d.call("account", { user: "d2" });
    await d.call("link", { user: "d1", platform: "telegram", id: "500000000000000001", login: "deetg" });
    await d.call("link", { user: "d1", platform: "twitch", id: "300000000000000001", login: "deetv", display: "DeeTV" });
    await d.call("unlink", { user: "d1", platform: "twitch" });
    await d.call("cosmetic", { action: "grant", user: "d1", item: "nc_mint" });
    await d.call("cosmetic", { action: "equip", user: "d1", item: "nc_mint" });
    assert.deepEqual(await d.call("textStyle", { user: "d1", color: "#60a5fa", font: "mono" }), { style: { color: "#60a5fa", font: "mono" } });
    await assert.rejects(d.call("textStyle", { user: "d1", color: "#123456" }), /palette/);
    const r = await d.call("looks", { ids: [acct, acct2], card: true });
    assert.equal(r.status, 200);
    const [a, b] = r.body.items;
    assert.equal(a.acct, acct);
    assert.deepEqual(a.name, { item: "nc_mint", kind: "solid", colors: ["#81c784"] });
    assert.deepEqual(a.text, { color: "#60a5fa", font: "mono", scope: "all" });
    assert.equal(a.verified, true, "a Camfrog login and a Telegram link");
    assert.equal(b.acct, acct2);
    await d.call("account", { user: "d3", login: "Other" });
    await d.call("moveLogin", { login: "Other", from: "d3", to: "d2" });
    await d.call("merge", { from: "d2", into: "d1" });
    const after = await d.call("looks", { ids: [acct2] });
    assert.deepEqual(after.body, { v: 1, items: [], missing: [acct2] }, "the merged account is missing");
    assert.equal((await d.call("looks", { ids: ["x"] })).status, 400);
  } finally {
    await d.close();
  }
});
