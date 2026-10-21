// S1 V4: tools/hubseam-driver.js's commands for the contract suite's cross-store scenario (the hub repo's
// seam-contract.integration.test.ts 5c, docs/seam-contract.md): chatLines seeds the account's web lines in the pad chat archive
// (a reported one, one in a room under a legal hold, an incognito one), deleteAccount {remove_public} deletes the account with
// "Also remove my public messages", chatLog reads the lines back - v1's real modules on a throwaway database, no hub.
//   node --test test/hubseam-driver-v4.test.js
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubseam-driver-v4-"));
  const env = { ...process.env, HUB_V1_ENV: "test", CHAT_GENESIS_NS: NS };
  for (const k of ["HUB_V1_URL", "HUB_V1_KEY", "HUB_V1_KEY_ID", "STAGING", "SITE_URL", "PUBLIC_BASE_URL", "CHATLOG_DB"]) delete env[k];
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

test("S1 V4 driver commands: chatLines / deleteAccount {remove_public} / chatLog", { timeout: 120000 }, async () => {
  const d = driver();
  try {
    await d.call("switches", { set: { erasure: true } });
    await d.call("account", { user: "v4a", login: "VeeFour" });
    await d.call("account", { user: "v4b" });
    const { cs } = await d.call("chatLines", { user: "v4a", lines: [
      { text: "plain words" }, { text: "reported words", report: true }, { text: "held words", room: "held" }, { text: "incognito words", incognito: true },
    ], hold_rooms: ["held"] });
    const { cs: other } = await d.call("chatLines", { user: "v4b", lines: [{ text: "someone else" }] });
    assert.equal(cs.length, 4);
    const before = (await d.call("chatLog", { cs })).lines;
    assert.deepEqual(before.map((l) => [l.text, l.who, l.down, l.purged]),
                     [["plain words", "account", false, false], ["reported words", "account", false, false], ["held words", "account", false, false],
                      ["incognito words", "hash", false, false]]);
    assert.ok(before[0].display, "named before");
    const { request } = await d.call("deleteAccount", { user: "v4a", remove_public: true });
    assert.match(request, /^\d+$/);
    const [plain, reported, held, incog] = (await d.call("chatLog", { cs })).lines;
    for (const l of [plain, incog]) assert.deepEqual([l.text, l.purged, l.down, l.rm_by, l.who, l.display], [null, true, true, "self", "hash", null]);
    for (const l of [reported, held]) assert.deepEqual([l.purged, l.down, l.rm_by, l.who, l.display], [false, true, "self", "account", null]);
    assert.equal(reported.text, "reported words");
    assert.equal(held.text, "held words");
    assert.deepEqual((await d.call("chatLog", { cs: other })).lines.map((l) => [l.text, l.down]), [["someone else", false]]);
    // without the choice: the archive keeps the words (a former member's line)
    await d.call("account", { user: "v4c" });
    const { cs: keep } = await d.call("chatLines", { user: "v4c", lines: [{ text: "kept words" }] });
    await d.call("deleteAccount", { user: "v4c" });
    assert.deepEqual((await d.call("chatLog", { cs: keep })).lines.map((l) => [l.text, l.down, l.display]), [["kept words", false, null]]);
  } finally {
    await d.close();
  }
});
