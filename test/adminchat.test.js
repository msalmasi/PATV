// S1 V1 (release L1; ADR 0007 D3, D15, OQ-19; seam plan §12.10): /admin/chat, the chat hub's break-glass form (adminchat.js,
// chatswitches.js, padhub.setBackend, views/admin/chat.ejs, the admin nav's Chat group, siteperms chat.*).
//   - no hub call: with a hub configured and every outbound connection, request and fetch stubbed to throw, the page, the
//     JSON and every change still work (the form works while the hub is down)
//   - who: admins (chat.breakglass, locked at Admin) see it and turn things OFF in one click; turning ON (CHAT_HUB, a pad to
//     hub) is a Pepe owner's, with a confirm step the server enforces; Staff / Assistants / members / visitors are sent away
//   - every change: a same-origin fetch (a cross-site POST is refused), a reason, one admin_audit row; a change to the same
//     value writes nothing
//   - the interlock: CHAT_HUB on needs the twelve seam switches (huboutbox.setSettings' other half is Q4's)
//   - Camfrog (and every other non-site) pad can't pick hub; hub_read is S2's
//   - after V1's review: a change and its audit row commit together (a row that can't be written rolls the change back);
//     the confirm step is decided inside the writing transaction (a stale on-post can't undo an admin's off in between);
//     turning off needs neither the pads nor padhub; a pad_hub row whose pad is gone can still go back to v1; the pad's
//     room_events row names "PATV staff"; reasons lose zero-width / bidi / separator characters and need a letter or digit
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
const crypto = require("crypto");
const { AsyncResource } = require("async_hooks");
// runs fn in this file's top-level context: outside any transaction a server handler has open (dbUtils keeps the open
// transaction in AsyncLocalStorage), so a request started from inside one is a separate request, as in production
const outside = AsyncResource.bind((fn) => fn());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "adminchat-test-")));
delete process.env.STAGING;
for (const k of ["HUB_V1_URL", "HUB_V1_KEY_ID", "HUB_V1_KEY", "HUB_V1_ENV", "HUB_V1_PROXY"]) delete process.env[k];
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const CS = require(path.join(repo, "chatswitches"));
const PH = require(path.join(repo, "padhub"));
const AC = require(path.join(repo, "adminchat"));
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
const OWN = { userId: "own", username: "boss" };
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
  await AC.init();
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
  AC.register(app, { addUser });
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
  const ejs = require("ejs");
  const navOf = async (cls) => ejs.renderFile(path.join(repo, "views", "partials", "admin-nav.ejs"), { section: "overview", me: { class: cls } });
  assert.match(await navOf("Admin"), /href="\/admin\/chat"/);
  for (const cls of ["Staff", "Assistant"]) assert.doesNotMatch(await navOf(cls), /href="\/admin\/chat"/, cls);
  // JSON
  for (const u of ["", "stf", "adm"]) assert.equal((await get("/api/admin/chat", u)).headers.get("cache-control"), "no-store", "JSON no-store: " + u);
  assert.equal((await get("/api/admin/chat", "")).status, 401);
  assert.equal((await get("/api/admin/chat", "stf")).status, 403);
  assert.equal((await get("/api/admin/chat", "fake")).status, 403, "Pepe's owner role on a site Staff account: not an admin here");
  const j = await (await get("/api/admin/chat", "adm")).json();
  assert.equal(j.ok, true);
  assert.equal(j.owner, false);
  assert.deepEqual(j.hub, { value: "off", updated: null, updated_by: null, default: "off" });
  assert.deepEqual(j.choices, [], "a plain admin gets no pads to move");
  assert.equal(j.pads_ok, true);
  assert.deepEqual([j.pads_more, j.choices_more], [false, false]);
  const jo = await (await get("/api/admin/chat", "own")).json();
  assert.equal(jo.owner, true);
  const ids = jo.choices.map((p) => p.room_id);
  assert.deepEqual(ids.slice(0, 2), ["patv:staff", "patv:canary"], "the pilot pads first");
  assert.ok(ids.includes("patv:makers") && !ids.includes("Frog.Pond") && !ids.includes("user:mem"), "site pads only: " + ids);
  assert.ok(jo.choices.every((p) => p.platform === "site" && p.backend === "v1"));
  const lastPilot = Math.max(...ids.map((id, i) => (AC.PILOT_PADS.includes(id) ? i : -1)));
  assert.ok(ids.findIndex((id) => !AC.PILOT_PADS.includes(id)) > lastPilot, "every pilot pad before the rest");
  assert.doesNotMatch(own, /id="acPadsMore"|id="acChoicesMore"|id="acPadsDown"/, "no truncation or unreadable note");
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
  // "www." isn't folded (authGuard.sameOriginFetch folds it; D15's sameOriginStrict doesn't): a host name, as an IP can't take www.
  const lh = `http://localhost:${port}`;
  const viaLocalhost = (src) => realFetch(lh + "/api/admin/chat/pad", { method: "POST", redirect: "manual",
    headers: Object.assign({ "x-user": "own", "x-requested-with": "fetch", "content-type": "application/json" }, src),
    body: JSON.stringify({ room_id: "patv:staff", backend: "v1", reason: REASON }) });
  for (const src of [{ origin: `http://www.localhost:${port}` }, { referer: `http://www.localhost:${port}/admin/chat` }]) {
    const r = await viaLocalhost(src);
    assert.equal(r.status, 403, JSON.stringify(src));
    assert.equal((await r.json()).code, "cross_site");
  }
  const same = await viaLocalhost({ origin: lh });
  assert.deepEqual([same.status, (await same.json()).changed], [200, false], "the same post from the host itself goes through (and changes nothing)");
  assert.equal(await nAudits(), before, "no audit row");
  assert.equal(await hubValue(), null, "no switch row");
  // the check itself: X-Requested-With: fetch and an Origin (else a Referer) whose host is exactly this Host
  const req = (h) => ({ get: (k) => h[k.toLowerCase()] });
  assert.equal(AC.sameOriginStrict(req({ host: "publicaccess.tv", origin: "https://publicaccess.tv", "x-requested-with": "fetch" })), true);
  assert.equal(AC.sameOriginStrict(req({ host: "publicaccess.tv", referer: "https://publicaccess.tv/admin/chat", "x-requested-with": "fetch" })), true);
  assert.equal(AC.sameOriginStrict(req({ host: "publicaccess.tv", origin: "https://www.publicaccess.tv", "x-requested-with": "fetch" })), false);
  assert.equal(AC.sameOriginStrict(req({ host: "publicaccess.tv", origin: "https://publicaccess.tv" })), false);
  assert.equal(AC.sameOriginStrict(req({ host: "publicaccess.tv", origin: "null", "x-requested-with": "fetch" })), false);
});

test("a reason is required for every change, on or off", async () => {
  for (const reason of [undefined, "", "   ", "\u0000\u0001", 7, "​​", "‮⁦﻿", "!!! -- ...", " \u0085"]) {
    let r = await post("/api/admin/chat/hub", "adm", { on: false, reason });
    assert.equal(r.status, 400, JSON.stringify(reason));
    assert.equal(r.j.code, "reason_required");
    r = await post("/api/admin/chat/pad", "adm", { room_id: "patv:staff", backend: "v1", reason });
    assert.equal(r.j.code, "reason_required");
  }
  assert.equal(AC.cleanReason("  a\n\tb  " + "x".repeat(300)).length, AC.REASON_MAX);
  assert.equal(AC.cleanReason(" roll\u0007back  now "), "roll back now");
  // after V1's review: format characters (zero-width, bidi controls, BOM) and lone surrogates out; C1 controls (NEL) and
  // line / paragraph separators to a space; a letter or a digit required; cut by character, never inside an emoji
  assert.equal(AC.cleanReason("‮roll​ back⁩"), "roll back");
  assert.equal(AC.cleanReason("a b\u0085c d\u009be"), "a b c d e");
  assert.equal(AC.cleanReason("ok \ud83d"), "ok", "a lone surrogate");
  assert.equal(AC.cleanReason("42"), "42");
  assert.equal(AC.cleanReason("🔥 rollback 🔥"), "🔥 rollback 🔥");
  assert.equal(AC.cleanReason("x".repeat(199) + "😀"), "x".repeat(199), "an emoji that doesn't fit is left out whole");
  assert.equal(AC.cleanReason("x".repeat(198) + "😀"), "x".repeat(198) + "😀");
  for (const s of ["x".repeat(199) + "😀", "y".repeat(150) + "👍".repeat(40)]) {
    const c = AC.cleanReason(s);
    assert.ok(c.length <= AC.REASON_MAX && !/[\ud800-\udbff]$/.test(c) && !/(^|[^\ud800-\udbff])[\udc00-\udfff]/.test(c), "no half character: " + c.length);
  }
  assert.equal(await hubValue(), null);
});

test("the interlock: CHAT_HUB on is refused (409 chat_hub_needs) until all twelve seam switches are on - Q4's included", async () => {
  assert.deepEqual([...CS.INTERLOCK], ["tickets", "sessions", "heartbeat", "privacy", "erasure", "export", "pads", "roles", "bans", "identity", "looks", "switches"],
                   "seam plan S1-D7's twelve");
  let r = await post("/api/admin/chat/hub", "own", { on: true, reason: REASON, confirm: true });
  assert.equal(r.status, 409);
  assert.equal(r.j.code, "chat_hub_needs");
  assert.deepEqual(r.j.missing, [...CS.INTERLOCK]);
  await seam(CS.INTERLOCK.filter((k) => k !== "switches"), true);
  r = await post("/api/admin/chat/hub", "own", { on: true, reason: REASON, confirm: true });
  assert.equal(r.j.code, "chat_hub_needs");
  assert.deepEqual(r.j.missing, ["switches"], "names exactly what is still off");
  // the module refuses too, whoever calls it (the check runs in the writing transaction)
  await assert.rejects(CS.set("CHAT_HUB", "on", OWN, { reason: REASON }), (e) => e.code === "chat_hub_needs" && e.status === 409 && e.needs.join() === "switches");
  assert.equal(await hubValue(), null);
  assert.equal((await audits("chat.switch")).length, 0);
  // the page shows it
  assert.match(await (await get("/admin/chat", "own")).text(), /id="acHubNeeds">It needs these seam switches on first: switches\./);
  await seam(["switches"], true);
  assert.deepEqual(await CS.needsNow(), []);
  assert.deepEqual((await AC.interlock()).missing, []);
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
  assert.equal(CS.chatHubOn(), true);
  assert.equal(await CS.chatHubOnNow(), true);
  let a = await audits("chat.switch");
  assert.equal(a.length, 1);
  assert.equal(a[0].admin_id, "own");
  assert.equal(a[0].admin_name, "boss");
  assert.deepEqual(JSON.parse(a[0].detail), { key: "CHAT_HUB", from: "off", to: "on" });
  assert.equal(a[0].reason, "Staff dogfood day 1");
  const row = CS.all().CHAT_HUB;
  assert.equal(row.value, "on");
  assert.equal(row.updated_by, "boss", "updated_by: the admin's username (an audit label)");
  assert.ok(row.updated > 0);
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
  // off is never refused, whatever the seam switches say
  await seam(["pads"], false);
  r = await post("/api/admin/chat/hub", "adm", { on: false, reason: "belt and braces" });
  assert.deepEqual([r.status, r.j.changed], [200, false]);
  await seam(["pads"], true);
  // bad bodies
  assert.equal((await post("/api/admin/chat/hub", "adm", { on: "yes", reason: REASON })).j.code, "bad_request");
  await assert.rejects(CS.set("dm_backend", "hub", OWN, { reason: REASON }), (e) => e.code === "bad_key", "dm_backend is S5's");
  await assert.rejects(CS.set("CHAT_HUB", "maybe", OWN, { reason: REASON }), (e) => e.code === "bad_value");
});

test("a pad's chat: Camfrog and other non-site pads can't pick hub; hub_read is S2's; the owner moves a site pad after a confirm, any admin moves it back", async () => {
  const own = "own", adm = "adm";
  let r = await post("/api/admin/chat/pad", own, { room_id: "Frog.Pond", backend: "hub", reason: REASON, confirm: true });
  assert.equal(r.status, 409);
  assert.equal(r.j.code, "site_pads_only", "a Camfrog pad keeps its v1 chat");
  r = await post("/api/admin/chat/pad", own, { room_id: "user:mem", backend: "hub", reason: REASON, confirm: true });
  assert.equal(r.j.code, "site_pads_only", "a profile pad too");
  await assert.rejects(PH.setBackend("Frog.Pond", "hub", OWN), (e) => e.code === "site_pads_only" && e.status === 409, "padhub refuses too");
  await assert.rejects(PH.setBackend("patv:staff", "hub_read", OWN), (e) => e.code === "hub_read_s2");
  assert.equal((await backendOf("Frog.Pond")).chat_backend, "v1");
  r = await post("/api/admin/chat/pad", own, { room_id: "patv:staff", backend: "hub_read", reason: REASON, confirm: true });
  assert.deepEqual([r.status, r.j.code], [409, "hub_read_s2"]);
  r = await post("/api/admin/chat/pad", own, { room_id: "patv:staff", backend: "HUB", reason: REASON, confirm: true });
  assert.deepEqual([r.status, r.j.code], [400, "bad_backend"]);
  r = await post("/api/admin/chat/pad", own, { room_id: "patv:nowhere", backend: "hub", reason: REASON, confirm: true });
  assert.deepEqual([r.status, r.j.code], [404, "no_pad"]);
  r = await post("/api/admin/chat/pad", adm, { room_id: "patv:nowhere", backend: "v1", reason: REASON });
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
  assert.equal(await PH.backendOf("patv:staff"), "hub");
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
  // a hand-edited value the form doesn't know: listed (as written), and any admin puts it back to v1
  await runQuery("UPDATE pad_hub SET chat_backend = 'HUB' WHERE room_id = 'patv:makers'");
  assert.ok((await AC.hubPads()).pads.some((p) => p.room_id === "patv:makers" && p.backend === "HUB"), "listed among the pads not on v1");
  assert.match(await (await get("/admin/chat", adm)).text(), /<td><code>HUB<\/code><\/td>/);
  r = await post("/api/admin/chat/pad", adm, { room_id: "patv:makers", backend: "v1", reason: "cleanup" });
  assert.deepEqual([r.status, r.j.changed], [200, true]);
  assert.equal((await backendOf("patv:makers")).chat_backend, "v1");
  assert.equal(JSON.parse((await audits("chat.pad_backend")).pop().detail).from, "HUB", "the audit row says what was stored");
});

test("no hub call: with a hub configured and the network stubbed to throw, the page, the JSON and every change work", async (t) => {
  Object.assign(process.env, { HUB_V1_URL: "https://hub.invalid", HUB_V1_KEY_ID: "v1-test-1", HUB_V1_KEY: "k".repeat(43), HUB_V1_ENV: "test" });
  t.after(() => { for (const k of ["HUB_V1_URL", "HUB_V1_KEY_ID", "HUB_V1_KEY", "HUB_V1_ENV"]) delete process.env[k]; });
  await seam(CS.INTERLOCK, true);
  // something queued for the hub, as the seam's triggers would write it
  await runQuery("INSERT INTO hub_outbox (topic, entity, created_at) VALUES ('switches/changed', 'sw:CHAT_HUB', ?)", [Date.now() - 5000]);
  const restore = stubNetwork();
  try {
    await assert.rejects(Promise.resolve().then(() => http.request("http://hub.invalid/")), /network call/, "the stub works");
    netCalls.length = 0;
    for (const u of ["own", "adm"]) {
      const waiting = (await getQuery("SELECT COUNT(*) AS n FROM hub_outbox WHERE posted_at IS NULL"))[0].n;
      assert.ok(waiting >= 1);
      const r = await get("/admin/chat", u);
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.match(html, /Set \(test\)/, "the poster's status: a hub is configured");
      assert.match(html, new RegExp(`Waiting to post</b><span>${waiting} waiting`), "this site's queue for the hub (per topic once Q4 adds the topics)");
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
  await seam(CS.INTERLOCK, true);
  await CS.set("CHAT_HUB", "on", OWN, { reason: "<script>alert(1)</script>" });
  await seam(["bans"], false);         // a seam switch off under an on CHAT_HUB (a hand edit): shown as off
  const html = await (await get("/admin/chat", "adm")).text();
  assert.match(html, /data-hub="on"/);
  assert.match(html, /Last changed .* by boss\./);
  assert.match(html, /id="acHubOff" data-hub-on="0"/, "any admin gets the off button");
  assert.match(html, /data-seam="bans"><b><code>bans<\/code><\/b><span><span class="adm-dot bad">/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "reasons escaped");
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /CHAT_HUB: off → on/);
  assert.match(html, /Pad staff: hub → v1/);
  await CS.set("CHAT_HUB", "off", { userId: "adm", username: "admin2" }, { reason: REASON });
  await seam(["bans"], true);
  // the owner's on button with every seam switch on
  assert.match(await (await get("/admin/chat", "own")).text(), /id="acHubOn" data-hub-on="1"/);
});

test("capabilities, the nav's group, the merge census and the logs", () => {
  const SP = require(path.join(repo, "siteperms"));
  assert.equal(SP.BY_KEY["chat.breakglass"].locked, "ops", "locked: seen and turned off by Admins only");
  assert.equal(SP.can({ class: "Admin" }, "chat.breakglass"), true);
  assert.equal(SP.can({ class: "Staff" }, "chat.breakglass"), false);
  assert.equal(SP.can({ class: "Assistant" }, "chat.mod_queue"), true, "assistants reach the hub's queue (V2's hosts)");
  assert.equal(SP.can({ class: "Staff" }, "chat.audit"), false);
  for (const k of ["chat.breakglass", "chat.mod_queue", "chat.audit"]) assert.ok(EN["siteperm.k." + k], k);
  assert.ok(EN["siteperm.g.chat"]);
  for (const [view, cap] of Object.entries(AC.MOD_VIEWS)) assert.ok(SP.BY_KEY[cap], view + " -> " + cap);
  for (const k of CS.INTERLOCK) assert.ok(EN["admchat.sw." + k], "label for " + k);
  // the merge census: chat_switches.updated_by is an audit label, never a user id; its other columns don't look like one
  const AM = require(path.join(repo, "accountMerge"));
  assert.ok(AM.RULES["chat_switches.updated_by"] && AM.RULES["chat_switches.updated_by"].deny);
  for (const c of ["key", "value", "updated"]) assert.ok(!AM.CANDIDATE.some((re) => re.test(c)), c);
  // nothing logs a reason, a pad or a value
  const src = ["adminchat.js", "chatswitches.js"].map((f) => fs.readFileSync(path.join(repo, f), "utf8")).join("\n");
  for (const m of src.matchAll(/console\.(?:log|error|warn)\(([^;]*)\);/g)) assert.doesNotMatch(m[1], /reason|room_id|value|\bb\.|detail/, m[0]);
});

// ── after V1's review ──

test("a change and its audit row commit together: when the row can't be written, nothing changes (switch and pad)", async () => {
  await seam(CS.INTERLOCK, true);
  assert.equal(await hubValue(), "off");
  const n0 = await nAudits();
  const events = async () => (await getQuery("SELECT COUNT(*) AS n FROM room_events WHERE room_id = 'patv:canary' AND what = 'chat-backend'"))[0].n;
  const ev0 = await events();
  await runQuery("CREATE TRIGGER IF NOT EXISTS t_audit_down BEFORE INSERT ON admin_audit WHEN NEW.action LIKE 'chat.%' BEGIN SELECT RAISE(ABORT, 'audit down'); END");
  try {
    let r = await post("/api/admin/chat/hub", "own", { on: true, reason: REASON, confirm: true });
    assert.deepEqual([r.status, r.j.code], [500, "internal"], JSON.stringify(r.j));
    assert.match(r.j.error, /nothing changed/);
    assert.equal(await hubValue(), "off", "the switch rolled back with its row");
    assert.equal(CS.chatHubOn(), false, "the cache too");
    await assert.rejects(CS.set("CHAT_HUB", "on", OWN, { reason: REASON }), /audit down/, "set() itself: a failed row is a failed change");
    assert.equal(await hubValue(), "off");
    r = await post("/api/admin/chat/pad", "own", { room_id: "patv:canary", backend: "hub", reason: REASON, confirm: true });
    assert.deepEqual([r.status, r.j.code], [500, "internal"]);
    assert.equal((await backendOf("patv:canary")).chat_backend, "v1", "the pad change rolled back with its row");
    assert.equal(await events(), ev0, "and its room_events row");
    assert.equal(await nAudits(), n0);
    // an actor-less set() (a script) writes no audit row, so it isn't held up by one
    assert.equal((await CS.set("CHAT_HUB", "off", null)).changed, false);
  } finally {
    await runQuery("DROP TRIGGER IF EXISTS t_audit_down");
  }
  // and with the log back: one row each
  let r = await post("/api/admin/chat/hub", "own", { on: true, reason: REASON, confirm: true });
  assert.deepEqual([r.status, r.j.value], [200, "on"]);
  r = await post("/api/admin/chat/hub", "adm", { on: false, reason: "rollback" });
  assert.deepEqual([r.status, r.j.value], [200, "off"]);
  assert.equal(await nAudits(), n0 + 2);
});

test("the confirm step is decided on a read inside the writing transaction: a stale on-post can't undo an admin's rollback in between", async (t) => {
  // The race is driven from the very read the confirm step rests on (V1's 2nd review: a hook placed after the read proved
  // only where the hook sat). The read returns what it saw, but only after an admin's off has started and had its chance to
  // land (up to 400 ms): inside the transaction the off queues behind it (dbUtils.tx runs one at a time), so what was read
  // still holds when the write runs; a read moved out of the transaction lets the off land first, and the stale value
  // would skip the confirm step and undo it; a read of the cache (chatHubOn) never reaches the stub at all.
  const realNow = CS.chatHubOnNow;
  t.after(() => { CS.chatHubOnNow = realNow; AC._setPadRead(null); });
  await seam(CS.INTERLOCK, true);
  // CHAT_HUB: on; an owner's tab still shows it on and posts on again without confirm while an admin turns it off
  assert.equal((await post("/api/admin/chat/hub", "own", { on: true, reason: REASON, confirm: true })).j.value, "on");
  const sw0 = (await audits("chat.switch")).length;
  let adminOff = null;
  CS.chatHubOnNow = async function () {
    const was = await realNow.apply(this, arguments);
    if (!adminOff) {
      adminOff = outside(() => post("/api/admin/chat/hub", "adm", { on: false, reason: "rollback mid-flight" }));
      await Promise.race([adminOff, sleep(400)]);
    }
    return was;
  };
  let r = await post("/api/admin/chat/hub", "own", { on: true, reason: "stale tab" });
  CS.chatHubOnNow = realNow;
  assert.ok(adminOff, "the confirm step read CHAT_HUB's row (chatHubOnNow), not the per-process cache");
  const off = await adminOff;
  assert.deepEqual([r.status, r.j.changed], [200, false], "read on, in its own transaction: nothing to change or confirm");
  assert.deepEqual([off.status, off.j.changed, off.j.value], [200, true, "off"]);
  assert.equal(await hubValue(), "off", "the admin's rollback stands");
  assert.equal((await audits("chat.switch")).length, sw0 + 1, "one row: the admin's off");
  r = await post("/api/admin/chat/hub", "own", { on: true, reason: "stale tab" });
  assert.deepEqual([r.status, r.j.code], [409, "confirm"], "from off it's the confirm step again");
  assert.equal(await hubValue(), "off");

  // a pad: on the hub; an owner's stale post (hub, no confirm) meets an admin's move back to v1
  assert.equal((await post("/api/admin/chat/pad", "own", { room_id: "patv:staff", backend: "hub", reason: REASON, confirm: true })).j.backend, "hub");
  const pd0 = (await audits("chat.pad_backend")).length;
  let adminBack = null;
  AC._setPadRead(async (read) => {
    const p = await read();
    if (!adminBack) {                  // the owner's read (the admin's own setPad reads through here too, after)
      adminBack = outside(() => post("/api/admin/chat/pad", "adm", { room_id: "patv:staff", backend: "v1", reason: "rollback mid-flight" }));
      await Promise.race([adminBack, sleep(400)]);
    }
    return p;
  });
  r = await post("/api/admin/chat/pad", "own", { room_id: "patv:staff", backend: "hub", reason: "stale tab" });
  assert.ok(adminBack, "the read ran");
  const back = await adminBack;
  AC._setPadRead(null);
  assert.deepEqual([r.status, r.j.changed], [200, false], JSON.stringify(r.j));
  assert.deepEqual([back.status, back.j.changed, back.j.backend], [200, true, "v1"]);
  assert.equal((await backendOf("patv:staff")).chat_backend, "v1", "the admin's move back stands");
  assert.equal((await audits("chat.pad_backend")).length, pd0 + 1);
  r = await post("/api/admin/chat/pad", "own", { room_id: "patv:staff", backend: "hub", reason: "stale tab" });
  assert.deepEqual([r.status, r.j.code], [409, "confirm"]);
});

test("the confirm step reads the row, not the cache: after an out-of-band off (the sqlite3 CLI fallback) an on-post without confirm is asked to confirm", async () => {
  await seam(CS.INTERLOCK, true);
  assert.equal((await post("/api/admin/chat/hub", "own", { on: true, reason: REASON, confirm: true })).j.value, "on");
  assert.equal(CS.chatHubOn(), true);
  // docs/chat-tickets.md's fallback when the page can't be used: the row set by hand, no load()
  await runQuery("UPDATE chat_switches SET value = 'off', updated = ?, updated_by = 'cli' WHERE key = 'CHAT_HUB'", [Date.now()]);
  assert.equal(CS.chatHubOn(), true, "the per-process cache still says on");
  const n0 = (await audits("chat.switch")).length;
  const r = await post("/api/admin/chat/hub", "own", { on: true, reason: "stale tab" });
  assert.deepEqual([r.status, r.j.code], [409, "confirm"], "read off from the row: the confirm step, nothing written");
  assert.equal(await hubValue(), "off", "the hand-set off stands");
  assert.equal((await audits("chat.switch")).length, n0);
  assert.equal(CS.chatHubOn(), false, "and the cache caught up");
});

test("the page: the switch read fresh, the change log newest first, pad titles escaped in the hub table", async () => {
  // an out-of-band write (a script, the sqlite3 CLI): the cache doesn't know it, the page does
  assert.equal(CS.chatHubOn(), false);
  await runQuery("UPDATE chat_switches SET value = 'on' WHERE key = 'CHAT_HUB'");
  assert.equal(CS.chatHubOn(), false, "the per-process cache (chatHubOn) is stale until a load");
  assert.equal(await CS.chatHubOnNow(), true, "chatHubOnNow reads the row");
  const j = await (await get("/api/admin/chat", "adm")).json();
  assert.equal(j.hub.value, "on", "the page reloads the switch");
  assert.equal(CS.chatHubOn(), true);
  await runQuery("UPDATE chat_switches SET value = 'off' WHERE key = 'CHAT_HUB'");
  assert.match(await (await get("/admin/chat", "adm")).text(), /data-hub="off"/);
  // newest first
  for (const why of ["older change", "newer change"]) {
    await post("/api/admin/chat/hub", "own", { on: true, reason: why, confirm: true });
    await post("/api/admin/chat/hub", "adm", { on: false, reason: why });
  }
  const log = (await (await get("/api/admin/chat", "adm")).json()).log;
  assert.ok(log.length >= 4);
  for (let i = 1; i < log.length; i++) assert.ok(log[i - 1].id > log[i].id, "newest first");
  assert.equal(log[0].reason, "newer change");
  let html = await (await get("/admin/chat", "adm")).text();
  assert.ok(html.indexOf("newer change") < html.indexOf("older change"), "the table too");
  // a title with markup, on the hub table (a plain admin's page: no owner <option> list to match instead)
  assert.equal((await post("/api/admin/chat/pad", "own", { room_id: "patv:makers", backend: "hub", reason: REASON, confirm: true })).j.backend, "hub");
  html = await (await get("/admin/chat", "adm")).text();
  assert.match(html, /<tr data-pad="patv:makers">[\s\S]*?Makers &lt;b&gt;<\/a>/);
  assert.match(html, /data-name="Makers &lt;b&gt;"/);
  assert.doesNotMatch(html, /Makers <b>/);
  assert.equal((await post("/api/admin/chat/pad", "adm", { room_id: "patv:makers", backend: "v1", reason: REASON })).j.backend, "v1");
});

test("a pad_hub row whose pad is gone is listed and goes back to v1; a pad's room_events row names PATV staff, never the admin", async () => {
  await runQuery("INSERT INTO pad_hub (room_id, hub_pad_id, chat_backend, updated, updated_by) VALUES ('patv:gone', ?, 'hub', ?, 'boss')",
                 [crypto.randomUUID(), Date.now()]);
  const listed = (await AC.hubPads()).pads.find((p) => p.room_id === "patv:gone");
  assert.ok(listed && listed.gone && listed.backend === "hub", "listed, marked gone");
  const html = await (await get("/admin/chat", "adm")).text();
  assert.match(html, /<tr data-pad="patv:gone">[\s\S]*?data-gone="1"[\s\S]*?data-pad-backend="v1" data-room="patv:gone"/, "with the one-click way back");
  let r = await post("/api/admin/chat/pad", "own", { room_id: "patv:gone", backend: "hub", reason: REASON, confirm: true });
  assert.deepEqual([r.status, r.j.code], [404, "no_pad"], "never to the hub");
  r = await post("/api/admin/chat/pad", "adm", { room_id: "patv:gone", backend: "v1", reason: "cleanup" });
  assert.deepEqual([r.status, r.j.changed, r.j.backend], [200, true, "v1"], JSON.stringify(r.j));
  assert.equal((await backendOf("patv:gone")).chat_backend, "v1");
  const d = JSON.parse((await audits("chat.pad_backend")).pop().detail);
  assert.deepEqual([d.room_id, d.from, d.slug], ["patv:gone", "hub", null]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM room_events WHERE room_id = 'patv:gone'"))[0].n, 0, "no pad, no pad event");
  await runQuery("DELETE FROM pad_hub WHERE room_id = 'patv:gone'");
  // the pad's owner reads room_events (/p/:slug/settings): staff show as PATV staff
  const actors = (await getQuery("SELECT DISTINCT actor FROM room_events WHERE what = 'chat-backend'")).map((x) => x.actor);
  assert.ok(actors.length >= 1);
  assert.deepEqual(actors, [PH.STAFF_ACTOR]);
  assert.equal(PH.STAFF_ACTOR, "PATV staff");
});

test("turning the chat hub off needs neither the pads nor padhub: with padhub down the page shows what it can and off works", async (t) => {
  await seam(CS.INTERLOCK, true);
  assert.equal((await post("/api/admin/chat/hub", "own", { on: true, reason: REASON, confirm: true })).j.value, "on");
  const realInit = PH.init;
  PH.init = () => Promise.reject(new Error("pads down"));
  t.after(() => { PH.init = realInit; });
  try {
    const r = await get("/admin/chat", "adm");
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /id="acPadsDown"/);
    assert.match(html, /id="acHubOff" data-hub-on="0"/, "the off button is there");
    assert.doesNotMatch(html, /id="acPadsNone"/, "never 'no pad is on the hub' when the pads can't be read");
    const j = await (await get("/api/admin/chat", "own")).json();
    assert.deepEqual([j.pads_ok, j.pads, j.choices, j.hub.value], [false, [], [], "on"]);
    const off = await post("/api/admin/chat/hub", "adm", { on: false, reason: "pads are down" });
    assert.deepEqual([off.status, off.j.changed, off.j.value], [200, true, "off"]);
    assert.equal(await hubValue(), "off");
  } finally { PH.init = realInit; }
});

test("the pad lists are bounded and say so (the site pads read in SQL, the pilot pads first)", async () => {
  let c = await AC.sitePadChoices(2);
  assert.deepEqual(c.pads.map((p) => p.room_id), ["patv:staff", "patv:canary"]);
  assert.equal(c.more, true);
  const all = (await AC.sitePadChoices()).pads.length;
  assert.ok(all >= 3);
  c = await AC.sitePadChoices(all);
  assert.deepEqual([c.pads.length, c.more], [all, false]);
  // more site pads than a list shows: the owner's page says so
  const t0 = Date.now();
  await require(path.join(repo, "dbUtils")).tx(async () => {
    for (let i = 0; i < AC.PAD_LIST_MAX + 5; i++) {
      await runQuery("INSERT INTO rooms_registry (room_id, slug, title, owner_kind, platform, created, updated) VALUES (?, ?, ?, 'none', 'site', ?, ?)",
                     ["patv:bulk" + i, "bulk-" + i, "Bulk " + String(i).padStart(4, "0"), t0, t0]);
    }
  });
  c = await AC.sitePadChoices();
  assert.deepEqual([c.pads.length, c.more], [AC.PAD_LIST_MAX, true]);
  assert.deepEqual(c.pads.slice(0, 2).map((p) => p.room_id), ["patv:staff", "patv:canary"], "the pilot pads first");
  assert.match(await (await get("/admin/chat", "own")).text(), /id="acChoicesMore">Only the first 500 site pads are listed/);
  await runQuery("UPDATE pad_hub SET chat_backend = 'hub' WHERE room_id LIKE 'patv:bulk%'");
  const h = await AC.hubPads();
  assert.deepEqual([h.pads.length, h.more], [AC.PAD_LIST_MAX, true]);
  assert.match(await (await get("/admin/chat", "adm")).text(), /id="acPadsMore">Only the first 500 are listed/);
  assert.equal((await AC.hubPads(1)).pads.length, 1);
  await runQuery("DELETE FROM rooms_registry WHERE room_id LIKE 'patv:bulk%'");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pad_hub WHERE room_id LIKE 'patv:bulk%'"))[0].n, 0, "pad_hub rows dropped with their pads");
});

// ── after V1's second review ──

const hubRow = async () => (await getQuery("SELECT value, updated, updated_by FROM chat_switches WHERE key = 'CHAT_HUB'"))[0] || null;

test("the interlock holds once CHAT_HUB has a row (S1-D7): an 'off' row and one seam switch off - refused by the route and by set()", async () => {
  await seam(CS.INTERLOCK, true);
  // a row exists: turned on and off once
  if (await hubValue() !== "on") assert.equal((await post("/api/admin/chat/hub", "own", { on: true, reason: REASON, confirm: true })).j.value, "on");
  assert.equal((await post("/api/admin/chat/hub", "adm", { on: false, reason: REASON })).j.value, "off");
  const row = await hubRow();
  assert.equal(row.value, "off");
  await seam(["bans"], false);
  const n0 = await nAudits();
  try {
    let r = await post("/api/admin/chat/hub", "own", { on: true, reason: REASON, confirm: true });
    assert.deepEqual([r.status, r.j.code, r.j.missing], [409, "chat_hub_needs", ["bans"]]);
    r = await post("/api/admin/chat/hub", "own", { on: true, reason: REASON });
    assert.deepEqual([r.status, r.j.code], [409, "chat_hub_needs"], "the interlock before the confirm step");
    await assert.rejects(CS.set("CHAT_HUB", "on", OWN, { reason: REASON }),
                         (e) => e.code === "chat_hub_needs" && e.status === 409 && e.needs.join() === "bans", "set() itself, with a row there");
    assert.deepEqual(await hubRow(), row, "nothing written");
    // a stored value set() doesn't know (a hand edit) reads as off: the interlock holds for it too
    await runQuery("UPDATE chat_switches SET value = 'ON' WHERE key = 'CHAT_HUB'");
    r = await post("/api/admin/chat/hub", "own", { on: true, reason: REASON, confirm: true });
    assert.deepEqual([r.status, r.j.code, r.j.missing], [409, "chat_hub_needs", ["bans"]]);
    await assert.rejects(CS.set("CHAT_HUB", "on", OWN, { reason: REASON }), (e) => e.code === "chat_hub_needs");
    assert.equal(await hubValue(), "ON");
    assert.equal(await nAudits(), n0);
  } finally {
    await runQuery("UPDATE chat_switches SET value = ?, updated = ?, updated_by = ? WHERE key = 'CHAT_HUB'", [row.value, row.updated, row.updated_by]);
    await CS.load();
    await seam(["bans"], true);
  }
});

test("a post that changes nothing writes nothing (the default with no row included); a stored value set() doesn't know is rewritten with its audit row", async (t) => {
  // every write to chat_switches counted, as Q4's switches/changed triggers would queue one
  await runQuery("CREATE TABLE IF NOT EXISTS t_sw_writes (n INTEGER)");
  await runQuery("CREATE TRIGGER IF NOT EXISTS t_sw_i AFTER INSERT ON chat_switches BEGIN INSERT INTO t_sw_writes VALUES (1); END");
  await runQuery("CREATE TRIGGER IF NOT EXISTS t_sw_u AFTER UPDATE ON chat_switches BEGIN INSERT INTO t_sw_writes VALUES (1); END");
  t.after(async () => { for (const s of ["DROP TRIGGER IF EXISTS t_sw_i", "DROP TRIGGER IF EXISTS t_sw_u", "DROP TABLE IF EXISTS t_sw_writes"]) await runQuery(s); });
  const writes = async () => (await getQuery("SELECT COUNT(*) AS n FROM t_sw_writes"))[0].n;
  await seam(CS.INTERLOCK, true);
  // no row (a fresh site, a staging refresh): CHAT_HUB is off, and turning it off changes nothing
  await runQuery("DELETE FROM chat_switches WHERE key = 'CHAT_HUB'");
  await CS.load();
  let w = await writes(), n = await nAudits();
  let r = await post("/api/admin/chat/hub", "adm", { on: false, reason: "belt and braces" });
  assert.deepEqual([r.status, r.j.changed, r.j.value, r.j.at], [200, false, "off", null]);
  assert.equal(await hubRow(), null, "no row written");
  assert.equal(await writes(), w);
  assert.equal(await nAudits(), n);
  assert.deepEqual(CS.all().CHAT_HUB, { value: "off", updated: null, updated_by: null, default: "off" });
  assert.match(await (await get("/admin/chat", "adm")).text(), /Never changed \(off by default\)\./, "no 'last changed by' without a change-log entry");
  assert.equal((await CS.set("CHAT_HUB", "off", OWN, { reason: REASON })).changed, false, "set() itself");
  assert.equal((await CS.set("CHAT_HUB", "off", null)).changed, false, "an actor-less set() too");
  assert.equal(await hubRow(), null);
  assert.equal(await writes(), w);
  // with a row: off again leaves updated / updated_by as they were
  assert.equal((await post("/api/admin/chat/hub", "own", { on: true, reason: REASON, confirm: true })).j.changed, true);
  assert.equal((await post("/api/admin/chat/hub", "adm", { on: false, reason: REASON })).j.changed, true);
  const row = await hubRow();
  assert.deepEqual([row.value, row.updated_by], ["off", "admin2"]);
  w = await writes();
  n = await nAudits();
  r = await post("/api/admin/chat/hub", "own", { on: false, reason: "again" });
  assert.deepEqual([r.status, r.j.changed], [200, false]);
  assert.deepEqual(await hubRow(), row, "updated / updated_by untouched");
  assert.deepEqual([await writes(), await nAudits()], [w, n]);
  // a stored value set() doesn't know (a hand edit): rewritten, and that write has its audit row (from = what was stored)
  await runQuery("UPDATE chat_switches SET value = 'ON' WHERE key = 'CHAT_HUB'");
  w = await writes();
  r = await post("/api/admin/chat/hub", "own", { on: false, reason: "cleanup" });
  assert.deepEqual([r.status, r.j.changed, r.j.value], [200, true, "off"]);
  assert.ok(r.j.at > 0);
  const now = await hubRow();
  assert.deepEqual([now.value, now.updated_by], ["off", "boss"]);
  assert.equal(await writes(), w + 1);
  assert.equal(await nAudits(), n + 1);
  const a = (await audits("chat.switch")).pop();
  assert.deepEqual([JSON.parse(a.detail), a.admin_id, a.reason], [{ key: "CHAT_HUB", from: "ON", to: "off" }, "own", "cleanup"]);
  assert.match(await (await get("/admin/chat", "adm")).text(), /CHAT_HUB: ON → off/);
});

test("room ids are escaped on the page; a pad's platform column wins over what its id implies; a non-site pad left on the hub is flagged", async () => {
  const ODD = `Frog"<Pond>&'s`;              // a Camfrog room's id is its room name, chosen off-site
  const SITE_ODD = `patv:x"<y>&'z`;
  const t0 = Date.now();
  const rows = [[ODD, "odd-frog", "Odd Frog", "camfrog"], [SITE_ODD, "odd-site", "Odd site", "site"],
                ["patv:bridged", "bridged", "Bridged", "camfrog"], ["Lobby.Site", "lobby-site", "Lobby site", "site"]];
  for (const [id, slug, title, platform] of rows) {
    await runQuery("INSERT INTO rooms_registry (room_id, slug, title, owner_kind, platform, created, updated) VALUES (?, ?, ?, 'none', ?, ?, ?)",
                   [id, slug, title, platform, t0, t0]);
  }
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");
  const reOf = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    // a Camfrog pad at hub (a re-key carried a site pad's row) and a site pad at hub: only the Camfrog one is flagged
    await runQuery("UPDATE pad_hub SET chat_backend = 'hub' WHERE room_id IN (?, 'patv:canary')", [ODD]);
    let html = await (await get("/admin/chat", "adm")).text();
    for (const s of [`<tr data-pad="${esc(ODD)}">`, `<code>${esc(ODD)}</code>`, `data-pad-backend="v1" data-room="${esc(ODD)}"`]) assert.ok(html.includes(s), s);
    assert.ok(!html.includes(ODD), "the id never raw");
    const rowOf = (id) => (html.match(new RegExp(`<tr data-pad="${reOf(esc(id))}">((?:(?!</tr>)[\\s\\S])*)</tr>`)) || [])[1] || "";
    assert.match(rowOf(ODD), /data-not-site="1">not a site pad/);
    assert.ok(rowOf("patv:canary").includes("patv:canary"));
    assert.doesNotMatch(rowOf("patv:canary"), /data-not-site/, "a site pad on the hub isn't flagged");
    // the owner's picker: a site pad's id escaped in the option's value and its text
    const own = await (await get("/admin/chat", "own")).text();
    assert.ok(own.includes(`<option value="${esc(SITE_ODD)}">`) && own.includes(`(${esc(SITE_ODD)})</option>`));
    assert.ok(!own.includes(SITE_ODD), "the id never raw");
    // the platform column wins over the id's prefix (rooms.js's rule), in the picker and in both checks
    assert.doesNotMatch(own, /value="patv:bridged"/, "a patv: id whose platform is camfrog isn't offered");
    assert.match(own, /<option value="Lobby\.Site">/, "a site pad without the patv: prefix is");
    let r = await post("/api/admin/chat/pad", "own", { room_id: "patv:bridged", backend: "hub", reason: REASON, confirm: true });
    assert.deepEqual([r.status, r.j.code], [409, "site_pads_only"]);
    await assert.rejects(PH.setBackend("patv:bridged", "hub", OWN), (e) => e.code === "site_pads_only", "padhub refuses too");
    assert.equal((await backendOf("patv:bridged")).chat_backend, "v1");
    r = await post("/api/admin/chat/pad", "own", { room_id: "Lobby.Site", backend: "hub", reason: REASON, confirm: true });
    assert.deepEqual([r.status, r.j.changed, r.j.backend], [200, true, "hub"], JSON.stringify(r.j));
    // every one goes back with one click, the odd id posted as written
    for (const id of [ODD, "patv:canary", "Lobby.Site"]) {
      r = await post("/api/admin/chat/pad", "adm", { room_id: id, backend: "v1", reason: "cleanup" });
      assert.deepEqual([r.status, r.j.changed, r.j.backend], [200, true, "v1"], id);
    }
    html = await (await get("/admin/chat", "adm")).text();
    assert.doesNotMatch(html, /data-not-site/);
  } finally {
    await runQuery(`DELETE FROM rooms_registry WHERE room_id IN (${rows.map(() => "?").join(",")})`, rows.map((x) => x[0]));
    await runQuery("UPDATE pad_hub SET chat_backend = 'v1' WHERE room_id = 'patv:canary'");
  }
});
