// 1.99ads (S1 Q5b): tools/hubseam-driver.js's identity and looks commands (seam-contract.md "Driver commands S1 adds") drive
// v1's real modules on a throwaway database: link / unlink / moveLogin / merge / cosmetic / textStyle write what the identity
// and looks topics read, and `looks` answers like POST /internal/v1/looks. S1 Q4 (release L1): pad / padMember / padLook /
// padChat / ownerGrant / premiumComp / stripeRenew / flair / role / pepeRoles / signup / feedBan / feedUnban / feedSweep /
// chatSwitch / beat write what pads/changed, roles/changed, bans/changed and switches/changed read (the interlock included).
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
  return { call, close, dir };
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

// S1 Q4 (release L1): the pad / role / ban / switch commands write what pads/changed, roles/changed, bans/changed and
// switches/changed read - the outbox rows are read back from the driver's own database
test("the S1 L1 pad / role / ban / switch driver commands", { timeout: 180000 }, async () => {
  const d = driver();
  const sqlite3 = require("sqlite3");
  const rows = (topic) => new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path.join(d.dir, "myapp.db"), sqlite3.OPEN_READONLY);
    db.all("SELECT entity FROM hub_outbox WHERE topic = ? ORDER BY id", [topic], (e, r) => { db.close(); if (e) reject(e); else resolve(r.map((x) => x.entity)); });
  });
  try {
    await d.call("switches", { set: { pads: true, roles: true, bans: true, switches: true } });
    await d.call("account", { user: "u1", login: "Uno" });
    await d.call("account", { user: "u2" });
    const { pad_id: pid } = await d.call("pad", { action: "create", pad: "patv:dpad", title: "Driver Pad", slug: "driver-pad", owner: "u1" });
    assert.match(pid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (const a of [{ action: "access", level: "approved" }, { action: "nsfw", on: true }, { action: "listed", on: false }, { action: "backend", backend: "hub" },
                     { action: "slug", slug: "driver-pad-2" }]) {
      assert.equal((await d.call("pad", { ...a, pad: "patv:dpad" })).pad_id, pid, a.action);
    }
    await assert.rejects(d.call("pad", { action: "backend", pad: "patv:dpad", backend: "hub_read" }), /S2/);
    await d.call("padMember", { pad: "patv:dpad", user: "u2", status: "approved" });
    await d.call("padLook", { pad: "patv:dpad", frame: "pp_frame", badges: ["pb_est2026"] });
    assert.deepEqual((await d.call("padChat", { pad: "patv:dpad", window_s: 3600, downloads: false })).settings, { window_s: 3600, search: null, downloads: 0, mods_all: null });
    await d.call("ownerGrant", { pad: "patv:dpad", on: true });
    await d.call("premiumComp", { pad: "patv:dpad", tier: "prime_plus", until: Date.now() + 86400000 });
    await d.call("stripeRenew", { pad: "patv:dpad", through: Date.now() + 2 * 86400000 });
    const { flair } = await d.call("flair", { action: "define", pad: "patv:dpad", name: "Frogs", emoji: "🐸", self: true });
    await d.call("flair", { action: "assign", pad: "patv:dpad", user: "u2", flair });
    const pads = await rows("pads/changed");
    assert.ok(pads.includes("pad:" + pid) && pads.includes(`pm:${pid}/u2`), JSON.stringify(pads));
    // roles: a role set on the website, Pepe's tombstone, a sign-up with a linked login
    await d.call("role", { login: "uno", role: "staff" });
    await d.call("pepeRoles", { map: { uno: [null, Date.now() + 1000] } });
    await d.call("signup", { user: "u3", login: "Tres" });
    const roles = await rows("roles/changed");
    assert.deepEqual(roles.filter((e) => e === "acct:u1").length >= 2 && roles.includes("acct:u3"), true, JSON.stringify(roles));
    // D11-site-roles: a site class on an account with no Camfrog login is its role (siteClass: the class picker, as the
    // driver's owner-Admin - the direct path on the site's ladder)
    await assert.rejects(d.call("siteClass", { user: "nobody", cls: "Staff" }), /no such account/);
    assert.deepEqual(await d.call("siteClass", { user: "u2", cls: "Admin" }), { role: "admin" });
    assert.ok((await rows("roles/changed")).includes("acct:u2"), "the class change posts the account");
    assert.deepEqual(await d.call("siteClass", { user: "u2", cls: "Staff" }), { role: "staff" }, "the owner demotes an unlinked Admin");
    assert.deepEqual(await d.call("siteClass", { user: "u2", cls: "pleb" }), { role: null });
    await assert.rejects(d.call("siteClass", { user: "u2", cls: "Bot" }), /^Error: siteClass: That class isn't on the list/);
    // a linked Staff member (Pepe's role, the class following it) who unlinks keeps nothing (staffroles' unlink trigger)
    await d.call("account", { user: "u4", login: "Cuatro" });
    await d.call("role", { login: "cuatro", role: "staff" });
    assert.deepEqual(await d.call("siteClass", { user: "u4", cls: "Staff" }), { role: "staff" }, "a linked account: Pepe's roles, unchanged");
    const clsOf = (id) => new Promise((resolve, reject) => {
      const db = new sqlite3.Database(path.join(d.dir, "myapp.db"), sqlite3.OPEN_READONLY);
      db.get("SELECT class FROM users WHERE userId = ?", [id], (e, r) => { db.close(); if (e) reject(e); else resolve(r && r.class); });
    });
    assert.equal(await clsOf("u4"), "Staff");
    await d.call("unlink", { user: "u4", platform: "camfrog" });
    assert.equal(await clsOf("u4"), "pleb", "the class went with the login");
    // bans: a pad ban, its unban, a site-wide one, the sweep
    await d.call("feedBan", { user: "u2", room: "patv:dpad", days: 1 });
    await d.call("feedUnban", { user: "u2", room: "patv:dpad" });
    await d.call("feedBan", { user: "u2" });
    assert.deepEqual((await d.call("feedSweep")).swept, 0);
    assert.deepEqual(await rows("bans/changed"), ["fb:u2/patv:dpad", "fb:u2/patv:dpad", "fb:u2/*"]);
    // switches: the interlock, then on and off
    const no = await d.call("chatSwitch", { key: "CHAT_HUB", value: "on" });
    assert.deepEqual([no.ok, no.code], [false, "chat_hub_needs"]);
    assert.ok(no.needs.includes("identity") && !no.needs.includes("pads"));
    await d.call("switches", { set: { tickets: true, sessions: true, heartbeat: true, privacy: true, erasure: true, export: true, identity: true, looks: true } });
    assert.deepEqual(await d.call("chatSwitch", { key: "CHAT_HUB", value: "on" }), { ok: true, value: "on", changed: true });
    await assert.rejects(d.call("switches", { set: { pads: false } }), /CHAT_HUB is on/);
    assert.deepEqual((await d.call("chatSwitch", { key: "CHAT_HUB", value: "off" })).value, "off");
    assert.deepEqual(await rows("switches/changed"), ["sw:CHAT_HUB", "sw:CHAT_HUB"]);
    assert.deepEqual(await d.call("beat", { action: "start", every_ms: 60000 }), { beating: true });
    assert.deepEqual(await d.call("beat", { action: "stop" }), { beating: false });
    // a padconnect re-key keeps the pad's id; a deletion posts it gone
    assert.equal((await d.call("pad", { action: "connect", pad: "patv:dpad", room: "Driver.Room" })).pad_id, pid);
    assert.equal((await d.call("pad", { action: "delete", pad: "Driver.Room" })).pad_id, pid);
  } finally {
    await d.close();
  }
});
