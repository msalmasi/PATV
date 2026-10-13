// Offline tests for 1.99vc: Pepe's command switches (cmdswitch.js) + the owner page's master-off display and TTS language
// (padowner.js / views/padOwner.ejs):
//   * Pepe's table: POST /api/pepe/cmdswitch/state (bot token), cleaned; the admin page + API are Admins only
//   * a change -> admin_audit row + website action(s) "cmd.switch" [field, value, id...] (chunked), checked against Pepe's
//     table (unknown ids, master-only switches, offline Pepe), same-site fetch only
//   * the owner page: a setting whose master is off shows disabled with "Switched off by PATV admins" (value kept); a change
//     to it is refused (409, nothing queued); the TTS language select (Pepe's list, a fallback note)
//   NODE_PATH=G:/PATV/node_modules node --test test/cmdswitch.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmdswitch-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PO = require(path.join(repo, "padowner"));
const CS = require(path.join(repo, "cmdswitch"));
const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));

const PLANT = "plant_based_chatting";
let base, server, owner, fan, staff, SLUG;
let n = 0;
async function mkUser(extra = {}) {
  const id = "c" + (++n);
  const name = extra.username || "user" + n;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, points_balance, camfrogUsername, class)
                  VALUES (?, ?, ?, 'x', ?, ?, ?)`, [id, name, name, 1000000, extra.camfrog || null, extra.cls || "pleb"]);
  return { userId: id, username: name, class: extra.cls || "pleb" };
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, level INTEGER DEFAULT 0,
                  avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  owner = await mkUser({ username: "pb", camfrog: "foamy1111" });
  fan = await mkUser({ username: "fan", camfrog: "fanguy" });
  staff = await mkUser({ username: "boss", cls: "Admin", camfrog: "bossy" });
  await rooms.init();
  await rooms.setOwner(PLANT, "foamy1111", "test");
  SLUG = (await rooms.get(PLANT)).slug || PLANT;
  require(path.join(repo, "actions"));
  await new Promise((r) => setTimeout(r, 200));
  await PO.init();
  await CS.init();
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const users = { owner, fan, staff };
  const addUser = (req, res, next) => { req.user = users[req.get("x-test-user")] || null; next(); };
  const isBotToken = (t) => t === "bot-token";
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken });
  CS.register(app, { addUser, isBotToken });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {});
const post = (p, u, body, h) => fetch(base + p, { method: "POST", headers: Object.assign(H(u), h || {}), body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, d: await r.json() }));
const get = (p, u) => fetch(base + p, { headers: u ? { "x-test-user": u } : {}, redirect: "manual" }).then(async (r) => ({ status: r.status, text: await r.text() }));
const actions = (kind) => getQuery("SELECT * FROM pepe_actions WHERE kind = ? ORDER BY id", [kind]);

function table(extra = []) {
  const sw = [
    { id: "imagine", kind: "feature", label: "!imagine - AI images", cat: "chat", ai: "image", cmds: ["!imagine"], master: true, default: true, has_default: false },
    { id: "video", kind: "feature", label: "!video - AI video", cat: "chat", ai: "video", cmds: ["!video"], master: true, default: true, has_default: false },
    { id: "greeter", kind: "feature", label: "Welcome-back greetings", cat: "ai", ai: "text", cmds: [], passive: true, master: false, default: true,
      has_default: true, rooms_own: 3, rooms_off: 1, owner: ["greeter", "greeter_note"] },
    { id: "tip", kind: "command", label: "!tip", cat: "wallet", ai: null, cmds: ["!tip"], master: true, default: true, has_default: true },
    { id: "<bad>", label: "junk" },
  ];
  for (let i = 0; i < 40; i++) sw.push({ id: "c" + i, kind: "command", label: "!c" + i, cat: "chat", cmds: ["!c" + i], master: true, default: true, has_default: true });
  return { switches: sw.concat(extra), categories: [["chat", "Chat & AI"], ["ai", "Pepe on his own"], ["<x>", "bad"]],
           audit: [{ ts: 1700000000, field: "master", on: false, by: "boss", via: "chat", ids: ["greeter"] }], orphans: ["oldone"] };
}

test("Pepe's table: bot token only, cleaned", async () => {
  CS._reset();
  let r = await post("/api/pepe/cmdswitch/state", null, { password: "nope", state: table() });
  assert.equal(r.status, 403);
  r = await post("/api/pepe/cmdswitch/state", null, { password: "bot-token", state: table() });
  assert.equal(r.status, 200);
  assert.equal(r.d.ok, true);
  const v = await CS.view();
  assert.equal(v.online, true);
  assert.ok(!v.state.switches.some((s) => s.id === "<bad>"), "junk id dropped");
  assert.deepEqual(v.state.categories, [["chat", "Chat & AI"], ["ai", "Pepe on his own"]]);
  const g = v.state.switches.find((s) => s.id === "greeter");
  assert.equal(g.master, false);
  assert.equal(g.rooms_own, 3);
  assert.deepEqual(g.owner, ["greeter", "greeter_note"]);
  assert.equal(v.state.switches.find((s) => s.id === "imagine").ai, "image");
});

test("the admin page + API: Admins only", async () => {
  let r = await get("/admin/pepe/commands", "fan");
  assert.equal(r.status, 403);
  r = await get("/admin/pepe/commands", null);
  assert.equal(r.status, 302);
  r = await get("/admin/pepe/commands", "staff");
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.ok(r.text.includes("Pepe's commands") && r.text.includes('id="csRows"'));
  r = await post("/api/admin/pepe/commands", "fan", { ids: ["imagine"], field: "master", value: "off" });
  assert.equal(r.status, 403);
  assert.equal((await actions("cmd.switch")).length, 0);
});

test("a change: audited, queued as cmd.switch, checked against Pepe's table, chunked", async () => {
  let r = await post("/api/admin/pepe/commands", "staff", { ids: ["imagine", "video"], field: "master", value: "off", reason: "GPU budget" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  let a = await actions("cmd.switch");
  assert.equal(a.length, 1);
  assert.deepEqual(JSON.parse(a[0].args), ["master", "off", "imagine", "video"]);
  assert.equal(a[0].site_admin, 1, "Pepe re-checks site_admin");
  const audit = await getQuery("SELECT * FROM admin_audit WHERE action = 'pepe_cmdswitch'");
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].detail), { field: "master", value: "off", ids: ["imagine", "video"] });
  assert.equal(audit[0].reason, "GPU budget");
  for (const [body, code] of [[{ ids: ["nope"], field: "master", value: "off" }, 404], [{ ids: ["imagine"], field: "default", value: "off" }, 400],
                              [{ ids: ["imagine"], field: "maybe", value: "off" }, 400], [{ ids: ["imagine"], field: "master", value: "meh" }, 400],
                              [{ ids: [], field: "master", value: "off" }, 400]]) {
    r = await post("/api/admin/pepe/commands", "staff", body);
    assert.equal(r.status, code, JSON.stringify(body));
  }
  r = await post("/api/admin/pepe/commands", "staff", { ids: ["imagine"], field: "master", value: "on" }, { "x-requested-with": "" });
  assert.equal(r.status, 403, "fetch only");
  await runQuery("UPDATE pepe_actions SET status = 'done'");
  const ids = Array.from({ length: 40 }, (_, i) => "c" + i);
  r = await post("/api/admin/pepe/commands", "staff", { ids, field: "default", value: "off" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  a = (await actions("cmd.switch")).slice(1);
  assert.equal(a.length, 2, "40 ids -> two actions");
  assert.equal(JSON.parse(a[0].args).length, 2 + CS.CHUNK);
  await runQuery("UPDATE pepe_actions SET status = 'done'");
  CS._setClock(() => Date.now() + 60 * 60 * 1000);
  r = await post("/api/admin/pepe/commands", "staff", { ids: ["imagine"], field: "master", value: "on" });
  assert.equal(r.status, 409, "Pepe offline -> refused");
  CS._setClock(null);
});

test("the owner page: master off = disabled + 'Switched off by PATV admins', value kept, change refused; TTS language", async () => {
  PO._reset();
  await runQuery("UPDATE pepe_actions SET status = 'done'");
  const report = { [PLANT]: { owner: { greeter: true, greeter_note: "be nice", snap: true, language: "auto", tts_language: "default" },
    bridge: { relay: true, cams: false }, admin: {},
    masters_off: { greeter: "Welcome-back greetings", greeter_note: "Welcome-back greetings", "br:relay": "Bridge: website chat", "Bad Key!": "x" },
    tts: { own: null, global: "auto", effective: "auto", voice: "dolly", engine: "qwen", supported: ["en", "es", "zh"], fallback: null } } };
  const choices = { vibe: ["auto"], roasts: ["auto"], tts: [["en", "English"], ["es", "Spanish"], ["he", "Hebrew"], ["<x>", "bad"]] };
  let r = await post("/api/rooms/owners", null, { password: "bot-token", room_settings: report, room_choices: choices });
  assert.equal(r.status, 200);
  const s = await PO.settingsFor(PLANT);
  assert.deepEqual(Object.keys(s.masters_off).sort(), ["br:relay", "greeter", "greeter_note"], "junk key dropped");
  assert.equal(s.owner.greeter, true, "the owner's own value is kept");
  assert.equal(s.tts.engine, "qwen");
  assert.deepEqual(PO.choices().tts, [["en", "English"], ["es", "Spanish"], ["he", "Hebrew"]]);
  const pg = await get("/p/" + SLUG + "/owner", "owner");
  assert.equal(pg.status, 200, pg.text.slice(0, 300));
  const row = pg.text.split('data-po-row="greeter"')[1].split('data-po-row=')[0];
  assert.ok(row.includes(en["owner.master_off"]), "the greeter row says it's switched off by PATV admins");
  assert.match(row, /data-po-set="greeter" checked\s+disabled/, "checked (kept) and disabled");
  const br = pg.text.split('data-po-row="br:relay"')[1].split('data-po-row=')[0];
  assert.ok(br.includes(en["owner.master_off"]) && /data-po-bridge="relay" checked\s+disabled/.test(br), "the bridge switch too");
  const snapRow = pg.text.split('data-po-row="snap"')[1].split('data-po-row=')[0];
  assert.ok(!snapRow.includes(en["owner.master_off"]) && !/disabled/.test(snapRow), "an untouched setting stays live");
  assert.ok(pg.text.includes('data-po-set="tts_language"') && pg.text.includes('<option value="es" >Spanish</option>'), "the TTS language select");
  assert.ok(pg.text.includes(en["owner.tts_not_voice"]), "a language the room's voice can't speak is marked");
  assert.ok(!/owner\.[a-z_]+\.?[a-z_-]*</.test(pg.text.replace(/<script[\s\S]*?<\/script>/g, "")), "no raw i18n keys");
  const before = (await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE kind = 'room.owner'"))[0].n;
  r = await post(`/api/rooms/${SLUG}/owner/setting`, "owner", { key: "greeter", value: "off" });
  assert.equal(r.status, 409, JSON.stringify(r.d));
  assert.match(r.d.error, /PATV admins/);
  r = await post(`/api/rooms/${SLUG}/owner/setting`, "owner", { key: "tts_language", value: "es" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const a = await getQuery("SELECT * FROM pepe_actions WHERE kind = 'room.owner' ORDER BY id");
  assert.equal(a.length, before + 1, "only the TTS change was queued");
  assert.deepEqual(JSON.parse(a[a.length - 1].args), [PLANT, "tts_language", "es"]);
  await runQuery("UPDATE pepe_actions SET status = 'done'");
  for (const v of ["xx1", "<b>", "fr"]) {
    r = await post(`/api/rooms/${SLUG}/owner/setting`, "owner", { key: "tts_language", value: v });
    assert.equal(r.status, 400, v);
  }
  // a fixed language the voice can't speak: the page says so
  report[PLANT].tts = { own: "he", global: "auto", effective: "he", voice: "dolly", engine: "qwen", supported: ["en", "es"], fallback: "en" };
  report[PLANT].owner.tts_language = "he";
  await post("/api/rooms/owners", null, { password: "bot-token", room_settings: report });
  const pg2 = await get("/p/" + SLUG + "/owner", "owner");
  assert.ok(pg2.text.includes("can&#39;t speak Hebrew") || pg2.text.includes("can't speak Hebrew"), "the fallback note");
});
