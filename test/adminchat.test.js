// S1 V1 (release L1; ADR 0007 D3, D15, OQ-19; seam plan §12.10): /admin/chat, the chat hub's break-glass form (adminchat.js,
// chatswitches.js, views/admin/chat.ejs, the admin nav's Chat group, siteperms chat.*).
//   - no hub call: with a hub configured and every outbound connection, request and fetch stubbed to throw, the page, the
//     JSON and every change still work (the form works while the hub is down)
//   - who: admins (chat.breakglass, locked at Admin) see it and turn things OFF in one click; turning ON (CHAT_HUB, a pad to
//     hub) is a Pepe owner's, with a confirm step the server enforces; Staff / Assistants / members / visitors are sent away
//   - every change: a same-origin fetch (a cross-site POST is refused), a reason, one admin_audit row in the same transaction;
//     a change to the same value writes nothing
//   - the interlock: CHAT_HUB on needs the twelve seam switches; while it is on none of them may go off (huboutbox.setSettings)
//   - Camfrog (and every other non-site) pad can't pick hub; hub_read is S2's
//   NODE_PATH=G:/PATV/node_modules node --test test/adminchat.test.js      (a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const tls = require("tls");
const http = require("http");
const https = require("https");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "adminchat-test-")));
delete process.env.STAGING;
for (const k of ["HUB_V1_URL", "HUB_V1_KEY_ID", "HUB_V1_KEY", "HUB_V1_ENV", "HUB_V1_PROXY"]) delete process.env[k];
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const CS = require(path.join(repo, "chatswitches"));
const HO = require(path.join(repo, "huboutbox"));
const EN = require(path.join(repo, "locales", "en.json"));

const realFetch = globalThis.fetch;
let base, server, port;
const H = (u, extra = {}) => Object.assign({ "x-user": u || "", origin: base, "x-requested-with": "fetch", "content-type": "application/json" }, extra);
const get = (p, u) => realFetch(base + p, { redirect: "manual", headers: H(u) });
const post = async (p, u, body, extra) => {
  const r = await realFetch(base + p, { method: "POST", redirect: "manual", headers: H(u, extra), body: JSON.stringify(body || {}) });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, j, cc: r.headers.get("cache-control") };
};
const audits = (action) => getQuery("SELECT * FROM admin_audit WHERE action = ? ORDER BY id", [action]);
const nAudits = async () => (await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action LIKE 'chat.%'"))[0].n;
const hubValue = async () => ((await getQuery("SELECT value FROM chat_switches WHERE key = 'CHAT_HUB'"))[0] || {}).value || null;
const backendOf = async (roomId) => (await getQuery("SELECT chat_backend, updated_by FROM pad_hub WHERE room_id = ?", [roomId]))[0];
/** The seam switches as /admin/keys stores them (Q4's pads / roles / bans / switches written the same way). */
async function seam(names, on) {
  for (const k of names) {
    await runQuery("INSERT INTO hubseam_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, on ? "true" : "false"]);
  }
  await HO.reloadSettings();
}
const REASON = "pilot rehearsal";

// the no-hub-call guard: any connection that isn't to this test's own server throws (and is counted)
const netCalls = [];
function stubNetwork() {
  const ours = (a) => {
    const o = a[0];
    const p = o && typeof o === "object" ? Number(o.port) : Number(o);
    const h = o && typeof o === "object" ? String(o.host || o.hostname || "") : String(a[1] || "");
    return p === port && (h === "" || h === "127.0.0.1" || h === "localhost");
  };
  const wrap = (obj, name, label) => {
    const orig = obj[name];
    obj[name] = function (...a) {
      if (label.startsWith("net.") && ours(a)) return orig.apply(this, a);
      netCalls.push(label);
      throw new Error("network call in a test that must make none: " + label);
    };
    return () => { obj[name] = orig; };
  };
  const undo = [wrap(net, "connect", "net.connect"), wrap(net, "createConnection", "net.createConnection"), wrap(tls, "connect", "tls.connect"),
                wrap(http, "request", "http.request"), wrap(http, "get", "http.get"), wrap(https, "request", "https.request"), wrap(https, "get", "https.get")];
  globalThis.fetch = () => { netCalls.push("fetch"); throw new Error("network call in a test that must make none: fetch"); };
  return () => { for (const u of undo) u(); globalThis.fetch = realFetch; };
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  camfrogUsername TEXT, points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 0, archived_at INTEGER)`);
  for (const [id, name, cls, cf] of [["own", "boss", "Admin", "BossFrog"], ["adm", "admin2", "Admin", "plainadmin"], ["stf", "staffer", "Staff", "stafffrog"],
                                     ["ast", "helper", "Assistant", null], ["mem", "member", "pleb", null], ["fake", "fakeowner", "Staff", "fakefrog"]]) {
    await runQuery("INSERT INTO users (userId, username, password, class, camfrogUsername) VALUES (?, ?, 'x', ?, ?)", [id, name, cls, cf]);
  }
  const SR = require(path.join(repo, "staffroles"));
  await SR.init();
  // boss: Admin + Pepe owner; admin2: Admin + Pepe admin; fakeowner: Pepe owner but only Staff on the site (never an owner here)
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('bossfrog', 'owner', 1), ('plainadmin', 'admin', 1), ('fakefrog', 'owner', 1)");
  await HO.init();
  await CS.init();
  // pads: the pilot site pads, a user's site pad, a Camfrog pad and a profile pad (pad_hub ids minted by padhub's trigger)
  const t = Date.now();
  for (const [id, slug, title, platform] of [["patv:staff", "staff", "Staff room", "site"], ["patv:canary", "canary", "Canary", "site"],
                                             ["patv:makers", "makers", "Makers <b>", "site"], ["Frog.Pond", "frog-pond", "Frog Pond", "camfrog"],
                                             ["user:mem", "u-member", "member", "profile"]]) {
    await runQuery("INSERT OR IGNORE INTO rooms_registry (room_id, slug, title, owner_kind, platform, created, updated) VALUES (?, ?, ?, 'none', ?, ?, ?)",
                   [id, slug, title, platform, t, t]);
  }
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  const addUser = async (req, res, next) => {
    const u = req.get("x-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  require(path.join(repo, "adminchat")).register(app, { addUser });
  require(path.join(repo, "adminkeys")).register(app, { addUser });
  server = app.listen(0);
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
test.after(() => server && server.close());

test("who sees it: admins (page + JSON, no-store, in the nav's Chat group); Staff to the Overview; others away", async () => {
  let r = await get("/admin/chat", "");
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /^\/login\?next=%2Fadmin%2Fchat/);
  r = await get("/admin/chat", "stf");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/admin", "Staff: the Overview");
  r = await get("/admin/chat", "ast");
  assert.equal(r.status, 302);
  assert.notEqual(r.headers.get("location"), "/admin/chat", "an Assistant: their own area home");
  assert.match((await get("/admin/chat", "mem")).headers.get("location"), /^\/login/);
  for (const u of ["adm", "own"]) {
    r = await get("/admin/chat", u);
    assert.equal(r.status, 200, u);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const html = await r.text();
    assert.match(html, /href="\/admin\/chat"/, "the Chat group in the admin nav");
    for (const id of ["hub", "pads", "interlock", "seam", "log"]) assert.match(html, new RegExp(`id="${id}"`), id);
    for (const k of CS.INTERLOCK) assert.match(html, new RegExp(`data-seam="${k}"`), "the interlock lists " + k);
    assert.match(html, /src="\/public\/js\/admin-chat\.js/);
  }
  const adm = await (await get("/admin/chat", "adm")).text();
  assert.match(adm, /id="acHubOwnerOnly"/, "a plain admin is told only owners turn it on");
  assert.match(adm, /id="acMoveOwnerOnly"/);
  assert.doesNotMatch(adm, /id="acHubOn"|id="acMovePad"/, "no on controls for a plain admin");
  const own = await (await get("/admin/chat", "own")).text();
  assert.match(own, /id="acHubOn" disabled/, "an owner's on button waits for the interlock");
  assert.match(own, /id="acMovePad"/);
  assert.match(own, /<option value="patv:staff">Staff room · pilot pad \(patv:staff\)/, "pilot pads first");
  assert.match(own, /Makers &lt;b&gt;/, "pad titles escaped");
  assert.doesNotMatch(own, /value="Frog\.Pond"|value="user:mem"/, "only site pads are offered");
  // the nav: only for chat.breakglass holders
  const nav = require("ejs");
  const navOf = async (cls) => nav.renderFile(path.join(repo, "views", "partials", "admin-nav.ejs"), { section: "overview", me: { class: cls } });
  assert.match(await navOf("Admin"), /href="\/admin\/chat"/);
  for (const cls of ["Staff", "Assistant"]) assert.doesNotMatch(await navOf(cls), /href="\/admin\/chat"/, cls);
  // JSON
  assert.equal((await get("/api/admin/chat", "")).status, 401);
  assert.equal((await get("/api/admin/chat", "stf")).status, 403);
  const j = await (await get("/api/admin/chat", "adm")).json();
  assert.equal(j.ok, true);
  assert.equal(j.owner, false);
  assert.deepEqual(j.hub, { key: "CHAT_HUB", value: "off", updated_at: null });
  assert.deepEqual(j.choices, [], "a plain admin gets no pads to move");
  assert.equal((await (await get("/api/admin/chat", "own")).json()).owner, true);
  assert.equal((await get("/api/admin/chat", "fake")).status, 403, "Pepe's owner role on a site Staff account: not an admin here");
});

test("cross-site, header-less and signed-out POSTs are refused; nothing changes", async () => {
  const before = await nAudits();
  for (const extra of [{ "x-requested-with": "" }, { origin: "https://evil.example" }, { origin: "" }]) {
    for (const [p, b] of [["/api/admin/chat/hub", { on: false, reason: REASON }], ["/api/admin/chat/pad", { room_id: "patv:staff", backend: "v1", reason: REASON }]]) {
      const r = await post(p, "own", b, extra);
      assert.equal(r.status, 403, p + " " + JSON.stringify(extra));
      assert.equal(r.j.code, "cross_site");
      assert.equal(r.cc, "no-store");
    }
  }
  assert.equal((await post("/api/admin/chat/hub", "", { on: false, reason: REASON })).status, 401);
  for (const u of ["stf", "ast", "mem", "fake"]) {
    const r = await post("/api/admin/chat/hub", u, { on: false, reason: REASON });
    assert.equal(r.status, 403, u);
    assert.equal(r.j.code, "admin_only", u);
  }
  assert.equal(await nAudits(), before, "no audit row");
  assert.equal(await hubValue(), null, "no switch row");
});

test("a reason is required for every change, on or off", async () => {
  for (const reason of [undefined, "", "   ", "\u0000\u0001", 7]) {
    let r = await post("/api/admin/chat/hub", "adm", { on: false, reason });
    assert.equal(r.status, 400, JSON.stringify(reason));
    assert.equal(r.j.code, "reason_required");
    r = await post("/api/admin/chat/pad", "adm", { room_id: "patv:staff", backend: "v1", reason });
    assert.equal(r.j.code, "reason_required");
  }
  assert.equal(CS.cleanReason("  a\n\tb  " + "x".repeat(300)).length, CS.REASON_MAX);
  assert.equal(CS.cleanReason(" roll\u0007back  now "), "roll back now");
});

test("the interlock: CHAT_HUB on is refused (409 chat_hub_needs) until all twelve seam switches are on - Q4's included", async () => {
  assert.deepEqual(CS.INTERLOCK, ["tickets", "sessions", "heartbeat", "privacy", "erasure", "export", "pads", "roles", "bans", "identity", "looks", "switches"],
                   "seam plan S1-D7's twelve");
  let r = await post("/api/admin/chat/hub", "own", { on: true, reason: REASON, confirm: true });
  assert.equal(r.status, 409);
  assert.equal(r.j.code, "chat_hub_needs");
  assert.deepEqual(r.j.missing, CS.INTERLOCK);
  await seam(CS.INTERLOCK.filter((k) => k !== "switches"), true);
  r = await post("/api/admin/chat/hub", "own", { on: true, reason: REASON, confirm: true });
  assert.equal(r.j.code, "chat_hub_needs");
  assert.deepEqual(r.j.missing, ["switches"], "names exactly what is still off");
  // the module refuses too, whoever calls it (the check runs in the writing transaction)
  await assert.rejects(CS.set("CHAT_HUB", "on", { userId: "own", username: "boss" }, REASON), (e) => e.code === "chat_hub_needs" && e.status === 409);
  assert.equal(await hubValue(), null);
  assert.equal((await audits("chat.switch")).length, 0);
  await seam(["switches"], true);
  assert.deepEqual((await CS.interlock()).missing, []);
});

test("an admin can turn CHAT_HUB off but not on; the owner turns it on after a confirm step; one audit row per change", async () => {
  await seam(CS.INTERLOCK, true);
  let r = await post("/api/admin/chat/hub", "adm", { on: true, reason: REASON, confirm: true });
  assert.equal(r.status, 403);
  assert.equal(r.j.code, "owner_only", "a plain admin can't turn it on");
  r = await post("/api/admin/chat/hub", "own", { on: true, reason: REASON });
  assert.equal(r.status, 409);
  assert.equal(r.j.code, "confirm", "the confirm step: nothing written without confirm: true");
  assert.deepEqual(r.j.preview, { pads: [], n: 0 });
  assert.equal(await hubValue(), null);
  r = await post("/api/admin/chat/hub", "own", { on: true, reason: "  Staff dogfood\tday 1 ", confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.cc, "no-store");
  assert.deepEqual([r.j.ok, r.j.changed, r.j.value], [true, true, "on"]);
  assert.equal(await hubValue(), "on");
  assert.equal(await CS.chatHubOn(), true);
  let a = await audits("chat.switch");
  assert.equal(a.length, 1);
  assert.equal(a[0].admin_id, "own");
  assert.equal(a[0].admin_name, "boss");
  assert.deepEqual(JSON.parse(a[0].detail), { key: "CHAT_HUB", from: "off", to: "on" });
  assert.equal(a[0].reason, "Staff dogfood day 1");
  const row = await CS.rowOf("CHAT_HUB");
  assert.equal(row.value, "on");
  assert.ok(row.updated_at > 0, "the switches/changed payload: {key, value, updated_at}");
  assert.deepEqual(await CS.all(), [row], "every key, for the snapshot");
  // on again: nothing changes, no row
  r = await post("/api/admin/chat/hub", "own", { on: true, reason: REASON });
  assert.deepEqual([r.status, r.j.changed], [200, false]);
  assert.equal((await audits("chat.switch")).length, 1);
  // any admin turns it off: one click (no confirm), never refused
  r = await post("/api/admin/chat/hub", "adm", { on: false, reason: "rollback" });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual([r.j.changed, r.j.value], [true, "off"]);
  assert.equal(await hubValue(), "off");
  a = await audits("chat.switch");
  assert.equal(a.length, 2);
  assert.equal(a[1].admin_id, "adm");
  assert.deepEqual(JSON.parse(a[1].detail), { key: "CHAT_HUB", from: "on", to: "off" });
  assert.equal(a[1].reason, "rollback");
  r = await post("/api/admin/chat/hub", "adm", { on: false, reason: "again" });
  assert.deepEqual([r.status, r.j.changed], [200, false], "off again changes nothing");
  assert.equal((await audits("chat.switch")).length, 2);
  // bad bodies
  assert.equal((await post("/api/admin/chat/hub", "adm", { on: "yes", reason: REASON })).j.code, "bad_request");
  await assert.rejects(CS.set("dm_backend", "hub", { userId: "own", username: "boss" }, REASON), (e) => e.code === "bad_key", "dm_backend is S5's");
  await assert.rejects(CS.set("CHAT_HUB", "maybe", { userId: "own", username: "boss" }, REASON), (e) => e.code === "bad_value");
});

test("the interlock's other half: while CHAT_HUB is on, no seam switch it needs may go off (huboutbox.setSettings, /admin/keys)", async () => {
  await seam(CS.INTERLOCK, true);
  const own = { userId: "own", username: "boss" };
  await CS.set("CHAT_HUB", "on", own, REASON);
  await assert.rejects(HO.setSettings({ identity: false }, own), (e) => e.code === "chat_hub_on" && e.status === 409 && e.refuse === true);
  await assert.rejects(HO.setSettings({ privacy: false, econ: false }, own), (e) => e.code === "chat_hub_on");
  assert.equal(HO.settings().identity, true, "nothing changed");
  assert.equal(HO.settings().privacy, true);
  // through /admin/keys#seam: the same refusal, its words name /admin/chat
  const r = await post("/api/admin/hubseam/settings", "own", { looks: false });
  assert.equal(r.status, 409);
  assert.equal(r.j.code, "chat_hub_on");
  assert.match(r.j.error, /CHAT_HUB off first/);
  // switches it doesn't need, and turning them on, are never refused
  await HO.setSettings({ econ: true }, own);
  await HO.setSettings({ econ: false }, own);
  await HO.setSettings({ identity: true }, own);
  // CHAT_HUB off first, then they go off
  await CS.set("CHAT_HUB", "off", own, REASON);
  await HO.setSettings({ identity: false }, own);
  assert.equal(HO.settings().identity, false);
  await HO.setSettings({ identity: true }, own);
});

test("a pad's chat: Camfrog and other non-site pads can't pick hub; hub_read is S2's; the owner moves a site pad after a confirm, any admin moves it back", async () => {
  const own = "own", adm = "adm";
  let r = await post("/api/admin/chat/pad", own, { room_id: "Frog.Pond", backend: "hub", reason: REASON, confirm: true });
  assert.equal(r.status, 409);
  assert.equal(r.j.code, "site_only", "a Camfrog pad keeps its v1 chat");
  r = await post("/api/admin/chat/pad", own, { room_id: "user:mem", backend: "hub", reason: REASON, confirm: true });
  assert.equal(r.j.code, "site_only", "a profile pad too");
  await assert.rejects(CS.setPadBackend("Frog.Pond", "hub", { userId: "own", username: "boss" }, REASON), (e) => e.code === "site_only", "the module refuses too");
  assert.equal((await backendOf("Frog.Pond")).chat_backend, "v1");
  r = await post("/api/admin/chat/pad", own, { room_id: "patv:staff", backend: "hub_read", reason: REASON, confirm: true });
  assert.deepEqual([r.status, r.j.code], [400, "not_in_s1"]);
  r = await post("/api/admin/chat/pad", own, { room_id: "patv:staff", backend: "HUB", reason: REASON, confirm: true });
  assert.deepEqual([r.status, r.j.code], [400, "bad_backend"]);
  r = await post("/api/admin/chat/pad", own, { room_id: "patv:nowhere", backend: "hub", reason: REASON, confirm: true });
  assert.deepEqual([r.status, r.j.code], [404, "no_pad"]);
  r = await post("/api/admin/chat/pad", own, { room_id: ["patv:staff"], backend: "hub", reason: REASON, confirm: true });
  assert.deepEqual([r.status, r.j.code], [400, "bad_request"]);
  r = await post("/api/admin/chat/pad", adm, { room_id: "patv:staff", backend: "hub", reason: REASON, confirm: true });
  assert.deepEqual([r.status, r.j.code], [403, "owner_only"], "a plain admin can't move a pad to the hub");
  r = await post("/api/admin/chat/pad", own, { room_id: "patv:staff", backend: "hub", reason: REASON });
  assert.deepEqual([r.status, r.j.code], [409, "confirm"], "the confirm step");
  assert.deepEqual(r.j.preview, { title: "Staff room", slug: "staff", chat_hub: false });
  assert.equal((await backendOf("patv:staff")).chat_backend, "v1", "nothing written before the confirm");
  const before = (await audits("chat.pad_backend")).length;
  r = await post("/api/admin/chat/pad", own, { room_id: "patv:staff", backend: "hub", reason: "staff dogfood", confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual([r.j.changed, r.j.room_id, r.j.backend], [true, "patv:staff", "hub"]);
  assert.deepEqual(await backendOf("patv:staff"), { chat_backend: "hub", updated_by: "boss" }, "updated_by is the admin's username (an audit label)");
  let a = await audits("chat.pad_backend");
  assert.equal(a.length, before + 1);
  const d = JSON.parse(a[a.length - 1].detail);
  assert.deepEqual([d.room_id, d.slug, d.from, d.to], ["patv:staff", "staff", "v1", "hub"]);
  assert.match(d.hub_pad_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a[a.length - 1].reason, "staff dogfood");
  // the page lists it; CHAT_HUB's preview names it
  const page = await (await get("/admin/chat", adm)).text();
  assert.match(page, /data-pad="patv:staff"/);
  assert.match(page, /data-pad-backend="v1" data-room="patv:staff"/, "any admin gets the one-click way back");
  await seam(CS.INTERLOCK, true);
  r = await post("/api/admin/chat/hub", own, { on: true, reason: REASON });
  assert.deepEqual(r.j.preview, { pads: ["Staff room"], n: 1 });
  // already on the hub: no confirm needed, nothing changes
  r = await post("/api/admin/chat/pad", own, { room_id: "patv:staff", backend: "hub", reason: REASON });
  assert.deepEqual([r.status, r.j.changed], [200, false]);
  // any admin moves it back - one click, no confirm
  r = await post("/api/admin/chat/pad", adm, { room_id: "patv:staff", backend: "v1", reason: "rollback" });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual([r.j.changed, r.j.backend], [true, "v1"]);
  assert.deepEqual(await backendOf("patv:staff"), { chat_backend: "v1", updated_by: "admin2" });
  a = await audits("chat.pad_backend");
  assert.equal(a.length, before + 2);
  assert.equal(a[a.length - 1].admin_id, "adm");
  r = await post("/api/admin/chat/pad", adm, { room_id: "patv:staff", backend: "v1", reason: "again" });
  assert.deepEqual([r.status, r.j.changed], [200, false]);
  assert.equal((await audits("chat.pad_backend")).length, before + 2, "no row for no change");
  // a Camfrog pad left at hub some other way (a re-key): any admin can still move it back
  await runQuery("UPDATE pad_hub SET chat_backend = 'hub' WHERE room_id = 'Frog.Pond'");
  r = await post("/api/admin/chat/pad", adm, { room_id: "Frog.Pond", backend: "v1", reason: "cleanup" });
  assert.deepEqual([r.status, r.j.changed], [200, true]);
  // a hand-edited value the form doesn't know: listed, and any admin puts it back to v1
  await runQuery("UPDATE pad_hub SET chat_backend = 'HUB' WHERE room_id = 'patv:makers'");
  assert.ok((await CS.hubPads()).some((p) => p.room_id === "patv:makers"), "listed among the pads not on v1");
  r = await post("/api/admin/chat/pad", adm, { room_id: "patv:makers", backend: "v1", reason: "cleanup" });
  assert.deepEqual([r.status, r.j.changed], [200, true]);
  assert.equal((await backendOf("patv:makers")).chat_backend, "v1");
  assert.equal(JSON.parse((await audits("chat.pad_backend")).pop().detail).from, "HUB", "the audit row says what was stored");
});

test("no hub call: with a hub configured and the network stubbed to throw, the page, the JSON and every change work", async (t) => {
  Object.assign(process.env, { HUB_V1_URL: "https://hub.invalid", HUB_V1_KEY_ID: "v1-test-1", HUB_V1_KEY: "k".repeat(43), HUB_V1_ENV: "test" });
  t.after(() => { for (const k of ["HUB_V1_URL", "HUB_V1_KEY_ID", "HUB_V1_KEY", "HUB_V1_ENV"]) delete process.env[k]; });
  await seam(CS.INTERLOCK, true);
  // something queued for the hub, as Q4's triggers would write it
  await runQuery("INSERT INTO hub_outbox (topic, entity, created_at) VALUES ('switches/changed', 'sw:CHAT_HUB', ?)", [Date.now() - 5000]);
  const restore = stubNetwork();
  try {
    await assert.rejects(Promise.resolve().then(() => http.request("http://hub.invalid/")), /network call/, "the stub works");
    netCalls.length = 0;
    for (const u of ["own", "adm"]) {
      const r = await get("/admin/chat", u);
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.match(html, /Set \(test\)/, "the poster's status: a hub is configured");
      assert.match(html, /Waiting to post<\/b><span>1 waiting/, "this site's queue for the hub (per topic once Q4 adds the topics)");
      assert.equal((await get("/api/admin/chat", u)).status, 200);
    }
    let r = await post("/api/admin/chat/pad", "own", { room_id: "patv:canary", backend: "hub", reason: REASON, confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    r = await post("/api/admin/chat/hub", "own", { on: true, reason: REASON, confirm: true });
    assert.deepEqual([r.status, r.j.value], [200, "on"]);
    r = await post("/api/admin/chat/hub", "adm", { on: false, reason: "hub is down" });
    assert.deepEqual([r.status, r.j.value], [200, "off"], "off works while the hub is unreachable");
    r = await post("/api/admin/chat/pad", "adm", { room_id: "patv:canary", backend: "v1", reason: "hub is down" });
    assert.deepEqual([r.status, r.j.backend], [200, "v1"]);
    assert.deepEqual(netCalls, [], "no request, connection or fetch left this process");
  } finally { restore(); }
});

test("the page shows the state, the interlock and an escaped change log", async () => {
  await CS.set("CHAT_HUB", "on", { userId: "own", username: "boss" }, "<script>alert(1)</script>");
  await seam(["bans"], false);         // a seam switch off under an on CHAT_HUB (a hand edit): shown as off
  const html = await (await get("/admin/chat", "adm")).text();
  assert.match(html, /data-hub="on"/);
  assert.match(html, /id="acHubOff" data-hub-on="0"/, "any admin gets the off button");
  assert.match(html, /data-seam="bans"><b><code>bans<\/code><\/b><span><span class="adm-dot bad">/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "reasons escaped");
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /CHAT_HUB: off → on/);
  assert.match(html, /Pad staff: hub → v1/);
  await CS.set("CHAT_HUB", "off", { userId: "adm", username: "admin2" }, REASON);
  await seam(["bans"], true);
  // the owner's on button with every seam switch on
  assert.match(await (await get("/admin/chat", "own")).text(), /id="acHubOn" data-hub-on="1"/);
});

test("capabilities, the nav, the page script's strings and the staging keep list", () => {
  const SP = require(path.join(repo, "siteperms"));
  assert.equal(SP.BY_KEY["chat.breakglass"].locked, "ops", "locked: ops is owner-only to turn on, admin-only to see");
  assert.equal(SP.can({ class: "Admin" }, "chat.breakglass"), true);
  assert.equal(SP.can({ class: "Staff" }, "chat.breakglass"), false);
  assert.equal(SP.can({ class: "Assistant" }, "chat.mod_queue"), true, "assistants reach the hub's queue (V2's hosts)");
  assert.equal(SP.can({ class: "Staff" }, "chat.audit"), false);
  for (const k of ["chat.breakglass", "chat.mod_queue", "chat.audit"]) assert.ok(EN["siteperm.k." + k], k);
  assert.ok(EN["siteperm.g.chat"]);
  const AC = require(path.join(repo, "adminchat"));
  for (const [view, cap] of Object.entries(AC.MOD_VIEWS)) assert.ok(SP.BY_KEY[cap], view + " -> " + cap);
  for (const k of CS.INTERLOCK) assert.ok(EN["admchat.sw." + k], "label for " + k);
  const K = require(path.join(repo, "deploy", "keep-staging-tables"));
  assert.ok(K.KEEP.includes("chat_switches"), "a staging refresh keeps staging's own CHAT_HUB");
  // the merge census: chat_switches has no user-id-looking column, and pad_hub.updated_by stays "not a user id"
  const AM = require(path.join(repo, "accountMerge"));
  for (const c of ["key", "value", "updated_at"]) assert.ok(!AM.CANDIDATE.some((re) => re.test(c)), c);
  // nothing in the module logs a reason, a pad or a value
  const src = fs.readFileSync(path.join(repo, "adminchat.js"), "utf8") + fs.readFileSync(path.join(repo, "chatswitches.js"), "utf8");
  for (const m of src.matchAll(/console\.(?:log|error|warn)\(([^;]*)\);/g)) assert.doesNotMatch(m[1], /reason|room_id|value|\bb\.|detail/, m[0]);
});
