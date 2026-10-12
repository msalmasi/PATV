// Offline tests for the room owner's Pepe control panel (padowner.js, views/padOwner.ejs, 1.99qr) and the banner chat-sponsor
// switch (banner.js chatSponsors):
//   * /p/<slug>/owner: the owner + staff only; it renders the vault, royalties, Prime Time, stage, Pepe and capability cards
//   * Pepe's room_settings report is cleaned + stored (POST /api/rooms/owners), shown, marked stale when old
//   * owner settings -> website action "room.owner" (validated keys/values, owner only)
//   * Top up -> website action "roomvault.deposit", KEYED (same idem = one action), amount checks (min, cap room, balance),
//     linked Camfrog name required
//   * the generated capability list is shipped, every capability + web capability has its strings, every WEB_CAPS route
//     exists in the code; /pads/owner-guide is public
//   * banner_chat_sponsor: off by default; on -> today's approved booking (headline + absolute link) for Pepe (bot token)
//   NODE_PATH=G:/PATV/node_modules node --test test/padowner.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "padowner-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PO = require(path.join(repo, "padowner"));
const BN = require(path.join(repo, "banner"));
const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));

const PLANT = "plant_based_chatting";
let base, server, owner, fan, staff, nolink, SLUG;
let n = 0;
async function mkUser(extra = {}) {
  const id = "v" + (++n);
  const name = extra.username || "user" + n;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, points_balance, camfrogUsername, class)
                  VALUES (?, ?, ?, 'x', ?, ?, ?)`, [id, name, name, extra.bal != null ? extra.bal : 1000000, extra.camfrog || null, extra.cls || "pleb"]);
  return { userId: id, username: name, class: extra.cls || "pleb" };
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, level INTEGER DEFAULT 0,
                  avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  owner = await mkUser({ username: "pb", camfrog: "foamy1111", bal: 200000 });
  fan = await mkUser({ username: "fan", camfrog: "fanguy" });
  staff = await mkUser({ username: "boss", cls: "Admin", camfrog: "bossy" });
  nolink = await mkUser({ username: "nolink" });
  await rooms.init();
  await rooms.setOwner(PLANT, "foamy1111", "test");
  SLUG = (await rooms.get(PLANT)).slug || PLANT;
  require(path.join(repo, "actions"));
  await new Promise((r) => setTimeout(r, 200));            // actions.js creates pepe_actions on load
  await PO.init();
  await BN.init();
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const users = { owner, fan, staff, nolink };
  const addUser = (req, res, next) => { req.user = users[req.get("x-test-user")] || null; next(); };
  const isBotToken = (t) => t === "bot-token";
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken });
  BN.register(app, { addUser, isBotToken, noTimers: true });
  app.get("/api/rooms/action-probe", (req, res) => res.end());
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {});
const post = (p, u, body) => fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, d: await r.json() }));
const page = (p, u) => fetch(base + p, { headers: u ? { "x-test-user": u } : {}, redirect: "manual" }).then(async (r) => ({ status: r.status, text: await r.text() }));
const actions = () => getQuery("SELECT * FROM pepe_actions ORDER BY id");

const LANGS_FROM_PEPE = [["auto", "Auto (follow the chat)", ""], ["en", "English", "English"], ["es", "Spanish", "Español"],
  ["zh-tw", "Chinese (Traditional)", "繁體中文"], ["<x>", "bad", ""]];
const REPORT = { [PLANT]: { owner: { snap: true, clip: false, challenge: true, language: "es" }, bridge: { relay: true, mic: false, cams: true, audio: false, transcripts: true, cmds: true },
  features: { say: true, look: false, casino_backend: true, nonsense: "x" }, prices: { look: 10000, roast: 5000, "BAD KEY": 3 }, vibe: { type: "chill", locked: false }, pepe_here: true },
  "bad id <script>": { owner: {} } };

test("Pepe's room_settings report is cleaned and stored with the owner-map sync", async () => {
  // before Pepe sent his language list, the select offers auto + the room's current value only
  assert.deepEqual(PO.languages().map((l) => l[0]), ["auto"]);
  const r = await post("/api/rooms/owners", null, { password: "bot-token", room_settings: REPORT, room_languages: LANGS_FROM_PEPE });
  assert.equal(r.status, 200);
  assert.deepEqual(PO.languages().map((l) => l[0]), ["auto", "en", "es", "zh-tw"], "1.99qv: Pepe's real list (junk dropped)");
  const s = await PO.settingsFor(PLANT);
  assert.deepEqual(s.owner, { snap: true, clip: false, challenge: true, language: "es" });
  assert.equal(s.features.nonsense, undefined);
  assert.equal(s.prices["BAD KEY"], undefined);
  assert.equal(s.prices.look, 10000);
  assert.equal(s.stale, false);
  assert.equal(await PO.settingsFor("bad id <script>"), null);
  assert.equal(PO.cleanOne({ owner: { language: "<bad>" } }).owner.language, "auto");
});

test("the owner page: owner + staff only; every card renders", async () => {
  let r = await page("/p/" + SLUG + "/owner", "owner");
  assert.equal(r.status, 200, r.text.slice(0, 400));
  for (const want of ['id="vault"', 'id="royalties"', 'id="prime"', 'id="stage"', 'id="pepe"', 'id="can"', 'data-po-set="snap"', 'data-po-set="language"',
                      'data-po-bridge="relay"', 'id="poTopup"', "!padvault deposit", en["owner.can_h"].replace(/'/g, "&#39;")]) {
    assert.ok(r.text.includes(want), want);
  }
  assert.ok(/<option value="es" selected>Spanish · Español<\/option>/.test(r.text), "the reported language is selected, Pepe's names");
  assert.ok(!/value="fr"/.test(r.text), "only the languages Pepe sent");
  assert.ok(!/owner\.[a-z_]+\.?[a-z_-]*</.test(r.text.replace(/<script[\s\S]*?<\/script>/g, "")), "no raw i18n keys on the page");
  r = await page("/p/" + SLUG + "/owner", "staff");
  assert.equal(r.status, 200);
  r = await page("/p/" + SLUG + "/owner", "fan");
  assert.equal(r.status, 403);
  r = await page("/p/" + SLUG + "/owner", null);
  assert.equal(r.status, 302);
  r = await page("/pads/owner-guide", null);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('id="cap-stage"') && r.text.includes('id="cap-web_vault_topup"'));
});

test("owner settings -> one room.owner action; validated; owner only", async () => {
  let r = await post(`/api/rooms/${SLUG}/owner/setting`, "owner", { key: "snap", value: "off" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  let a = (await actions()).pop();
  assert.equal(a.kind, "room.owner");
  assert.deepEqual(JSON.parse(a.args), [PLANT, "snap", "off"]);
  r = await post(`/api/rooms/${SLUG}/owner/setting`, "owner", { key: "language", value: "zh-tw" });
  assert.equal(r.status, 200);
  for (const [k, v] of [["say", "off"], ["snap", "maybe"], ["language", "klingon"], ["dj", "on"]]) {
    r = await post(`/api/rooms/${SLUG}/owner/setting`, "owner", { key: k, value: v });
    assert.equal(r.status, 400, k);
  }
  r = await post(`/api/rooms/${SLUG}/owner/setting`, "fan", { key: "snap", value: "on" });
  assert.equal(r.status, 403);
  const bad = await fetch(`${base}/api/rooms/${SLUG}/owner/setting`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "owner" }, body: '{"key":"snap","value":"on"}' });
  assert.equal(bad.status, 400, "no X-Requested-With -> refused");
});

test("top up = a keyed roomvault.deposit action; amount checks; linked name required", async () => {
  await runQuery("DELETE FROM pepe_actions");
  await require(path.join(repo, "roomvaults")).sync({ on: true, cap: 50000000, rooms: [{ id: PLANT, balance: 1000, days: {}, history: [] }] });
  const idem = "k" + "a".repeat(20);
  let r = await post(`/api/rooms/${SLUG}/vault/topup`, "owner", { amount: 50000, idem });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  let rows = await actions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "roomvault.deposit");
  assert.deepEqual(JSON.parse(rows[0].args), [PLANT, "50000"]);
  assert.equal(rows[0].camfrog, "foamy1111");
  const again = await post(`/api/rooms/${SLUG}/vault/topup`, "owner", { amount: 50000, idem });
  assert.equal(again.status, 200);
  assert.equal(again.d.duplicate, true);
  assert.equal(again.d.id, rows[0].id, "the same key is the same deposit");
  assert.equal((await actions()).length, 1, "a double click queues one action");
  for (const [amt, why] of [[999, /at least/], [10.5, /at least/], ["abc", /at least/], [300000, /don't have/]]) {
    r = await post(`/api/rooms/${SLUG}/vault/topup`, "owner", { amount: amt, idem: "k" + Math.random().toString(36).slice(2, 14) });
    assert.equal(r.status, 400, String(amt));
    assert.match(r.d.error, why);
  }
  r = await post(`/api/rooms/${SLUG}/vault/topup`, "owner", { amount: 5000, idem: "x" });
  assert.equal(r.status, 400, "a junk key is refused");
  r = await post(`/api/rooms/${SLUG}/vault/topup`, "fan", { amount: 5000, idem: "k" + "b".repeat(20) });
  assert.equal(r.status, 403, "not the owner");
  await runQuery("UPDATE users SET camfrogUsername = NULL WHERE userId = ?", [owner.userId]);
  r = await post(`/api/rooms/${SLUG}/vault/topup`, "owner", { amount: 5000, idem: "k" + "c".repeat(20) });
  assert.equal(r.status, 403);
  assert.match(r.d.error, /Link your Camfrog/);
  await runQuery("UPDATE users SET camfrogUsername = 'foamy1111' WHERE userId = ?", [owner.userId]);
});

test("the capability list: shipped, translated, and every web capability's route exists", () => {
  const caps = PO.capabilities();
  assert.ok(caps.capabilities.length >= 8, "generated list present");
  for (const c of caps.capabilities) {
    assert.ok(en[`owner.cap.${c.id}.title`] && en[`owner.cap.${c.id}.howto`], c.id);
    assert.ok(Array.isArray(c.code) && c.code.length, c.id + " names its code");
  }
  (caps.admin_only || []).forEach((a, i) => assert.equal(en[`owner.ao.${i}`], a.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), "admin_only " + i));
  const src = fs.readdirSync(repo).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(repo, f), "utf8")).join("\n")
    + fs.readFileSync(path.join(repo, "casino", "routes.js"), "utf8");
  for (const c of PO.WEB_CAPS) {
    assert.ok(en[`owner.cap.${c.id}.title`] && en[`owner.cap.${c.id}.howto`], c.id);
    const [method, p] = c.route.split(" ");
    assert.ok(src.includes(`app.${method.toLowerCase()}("${p}"`), `${c.route} is a real route`);
  }
});

test("every owner.* / js.owner.* / js.pad.pepe.* key the panel uses is in en.json", () => {
  const view = fs.readFileSync(path.join(repo, "views", "padOwner.ejs"), "utf8");
  const js = ["pad-owner.js", "pad-pepe.js"].map((f) => fs.readFileSync(path.join(repo, "public", "js", f), "utf8")).join("\n");
  const keys = new Set();
  for (const m of view.matchAll(/t\('((?:owner)\.[a-z0-9_.-]+)'/g)) if (!/[._]$/.test(m[1])) keys.add(m[1]);
  for (const m of js.matchAll(/_t\('((?:js\.owner|js\.pad\.pepe)\.[a-z0-9_]+)'/g)) keys.add(m[1]);
  for (const k of ["snap", "clip", "challenge", "language"]) { keys.add("owner.set_" + k); keys.add("owner.set_" + k + "_why"); }
  for (const k of ["relay", "mic", "cams", "audio", "transcripts"]) { keys.add("owner.br_" + k); keys.add("owner.br_" + k + "_why"); }
  for (const a of ["room", "stage", "vault", "games", "feed", "tier"]) keys.add("owner.area_" + a);
  assert.ok(keys.size > 80);
  for (const k of keys) assert.ok(k in en, k);
});

test("banner chat sponsor: off by default; on -> today's approved booking for Pepe, bot token only", async () => {
  let r = await post("/api/banner/chat-sponsors", null, { password: "bot-token" });
  assert.equal(r.status, 200);
  assert.deepEqual([r.d.on, r.d.items], [false, []]);
  r = await post("/api/banner/chat-sponsors", null, { password: "nope" });
  assert.equal(r.status, 403);
  await BN.setConfig({ banner_chat_sponsor: true }, "test");
  assert.equal(BN.settingsView().banner_chat_sponsor, true);
  const today = BN.dayKey(Date.now());
  for (const [id, status, link, day] of [["aaaaaaaaaaaa", "approved", "/p/plant", today], ["bbbbbbbbbbbb", "pending", "https://x.test/", BN.addDays(today, 1)]]) {
    await runQuery(`INSERT INTO banner_bookings (id, user_id, username, start_day, days, kind, headline, line, link, price, ref, status, created)
                    VALUES (?, ?, 'pb', ?, 2, 'text', 'Frog Fest', 'Saturday', ?, 1, ?, ?, ?)`, [id, owner.userId, day, link, "ref" + id, status, Date.now()]);
    await runQuery("INSERT INTO banner_days (day, booking_id) VALUES (?, ?)", [day, id]);
  }
  r = await post("/api/banner/chat-sponsors", null, { password: "bot-token" });
  assert.equal(r.d.on, true);
  assert.equal(r.d.mic, true, "1.99tc: mic mode (default on) -> Pepe also reads it aloud where TTS is on");
  assert.equal(r.d.items.length, 1, "only today's approved booking");
  const it = r.d.items[0];
  assert.deepEqual([it.id, it.headline, it.line, it.link], ["aaaaaaaaaaaa", "Frog Fest", "Saturday", "https://publicaccess.tv/p/plant"]);
  assert.equal(it.until, BN.dayStart(BN.addDays(today, 2)), "runs until the end of its last booked day");
  await BN.setConfig({ banner_chat_sponsor_mic: false }, "test");
  r = await post("/api/banner/chat-sponsors", null, { password: "bot-token" });
  assert.deepEqual([r.d.on, r.d.mic, r.d.items.length], [true, false, 1], "mic mode off -> text only");
  await BN.setConfig({ banner_chat_sponsor: false, banner_chat_sponsor_mic: true }, "test");
  r = await post("/api/banner/chat-sponsors", null, { password: "bot-token" });
  assert.deepEqual(r.d.items, [], "switched off -> Pepe drops it");
});
