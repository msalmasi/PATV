// 1.99rn: the heist sheet page on the site (gtfsheet.js, /gtf/sheet/:login) + web re-rolls.
//   * GTF data in Pepe: his display mirror (/api/gtf/bot/sheet-mirror) + catalog (/api/gtf/bot/meta) draw the page;
//     a re-roll is a website action for Pepe (`!sheet regen` / `!avatar regen`)
//   * GTF data on the site: the site re-rolls - one transaction: wallet debit + route intent (flow sheetregen /
//     avatarregen, Pepe routes it) + the new sheet + a gtf_op for Pepe; keyed (a retry never charges twice); numbers past
//     2^53 untouched; Pepe's puts of that sheet are deferred until he acks the op
//   * privacy: the profile layout's "gtf" section hidden -> only the owner / admins see the page
//   * every sheet link (gtf.sheetFor: profile, /gtf) points at /gtf/sheet/<login>
//   NODE_PATH=G:/PATV/node_modules node --test test/gtfsheet.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gtfsheet-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const G = require(path.join(repo, "gtfstore"));
const S = require(path.join(repo, "gtfsheet"));
const GTF = require(path.join(repo, "gtf"));
const PL = require(path.join(repo, "profilelayout"));

const BIG = "28862561789771469";
const SHEET = `{"avatar_seed":4242,"best_stat":"dex","brawl_losses":1,"brawl_net":-500,"brawl_wins":2,"busts":2,"class":"Burglar","cracks":3,` +
  `"created":"2026-09-01","deepest":9,"done_casino":true,"gear":["armor"],"heat_ts":${Math.floor(Date.now() / 1000) - 3600},"heat_val":70,` +
  `"heists":11,"items":{"kingpinring":0,"lockpick":3,"schematics":1},"loot":${BIG},"rings":[{"date":"2026-09-02","stat":"str"}],` +
  `"spent_points":1,"stats":{"cha":8,"con":12,"dex":17,"int":10,"str":14,"wis":9}}`;
const PVP = '{"losses":2,"net":30000,"wins":5}';
const CAT = { shop: { lockpick: { name: "Lockpick", emoji: "🔓", kind: "item", cost: 1000, desc: "DEX rescue" },
                      armor: { name: "Body Armor", emoji: "🦺", kind: "gear", cost: 15000, desc: "+2 CON" },
                      schematics: { name: "Schematics", emoji: "🗺️", kind: "item", cost: 12500 } },
              prices: { sheetregen: 50000, avatarregen: 20000 }, heat_max: 100, heat_decay: 40, levels_per_point: 10, item_cap: 10 };

let base, server, cookieUser = null;
const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const web = (p, body) => post(p, body, { "X-Requested-With": "fetch", origin: base, "sec-fetch-site": "same-origin" });
const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  for (const [id, name, cf, b, lvl, cls] of [["u1", "ann", "Ann_CF", 100000, 34, "pleb"], ["u2", "bob", "bob", 0, 3, "pleb"], ["u9", "boss", null, 0, 1, "Admin"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, points_balance, level, class) VALUES (?, ?, ?, 'x', ?, ?, ?, ?)",
                   [id, name, name.toUpperCase(), cf, b, lvl, cls]);
  }
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { if (cookieUser) req.user = { userId: cookieUser, username: cookieUser }; next(); };
  const deps = { isBotToken: (t) => t === "bot", addUser };
  G.register(app, deps);
  S.register(app, deps);
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await S.init();
});
test.after(() => server && server.close());

test("GTF data in Pepe: his mirror + catalog draw the sheet (stats, record, loadout with art, fights, heat)", async () => {
  assert.equal((await post("/api/gtf/bot/meta", { password: "bot", catalog: CAT })).status, 200);
  const m = await post("/api/gtf/bot/sheet-mirror", { password: "bot", full: true, sheets: { ann_cf: SHEET, bob: '{"stats":{"str":10}}' }, pvp: { ann_cf: PVP }, display: { ann_cf: "Ann" } });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  const v = await S.view("ANN_CF", null);
  assert.equal(v.mode, "mirror");
  assert.equal(v.cls, "Burglar");
  assert.deepEqual(v.stats.find((s) => s.key === "dex"), { key: "dex", score: 17, mod: 3, best: true, pct: 82 });
  assert.equal(v.stats.find((s) => s.key === "cha").mod, -1);
  assert.equal(v.record.loot, BIG, "loot exact past 2^53");
  assert.equal(v.record.cracks, "3");
  assert.equal(v.heat, 30, "heat cooled 40/h for an hour");
  assert.equal(v.avail, 2, "level 34 -> 3 points, 1 spent");
  assert.deepEqual(v.items.map((i) => [i.key, i.n]), [["schematics", 1], ["lockpick", 3]], "items by value, empty stacks hidden");
  assert.equal(v.items[1].art, "/public/img/badges/ach/cf_use_lockpick.png");
  assert.equal(v.gear[0].art, "/public/img/gtf/items/armor.png");
  for (const it of v.items.concat(v.gear)) if (it.art) assert.ok(fs.existsSync(path.join(repo, it.art.replace(/^\//, ""))), it.art);
  assert.deepEqual(v.pvp, { duels: { w: 5, l: 2, net: 30000 }, brawls: { w: 2, l: 1, net: -500 }, arena: 0 });
  assert.equal(v.rings.n, 1);
  assert.equal(v.avatar.seed, 4242);
  // a full mirror push drops sheets Pepe no longer has
  await post("/api/gtf/bot/sheet-mirror", { password: "bot", full: true, sheets: { ann_cf: SHEET }, pvp: { ann_cf: PVP } });
  assert.ok((await S.view("bob", null)).missing);
});

test("every sheet link goes to /gtf/sheet/<login> (profile, /gtf)", async () => {
  assert.deepEqual(await GTF.sheetFor("Ann_CF"), { url: "/gtf/sheet/ann_cf", cls: "Burglar" });
  assert.equal(await GTF.sheetFor("nobody"), null);
});

test("privacy: a hidden GTF section -> visitors get 'private', the owner and admins see it", async () => {
  const l = await PL.get("u1");
  await PL.save("u1", Object.assign({}, l, { hidden: (l.hidden || []).concat(["gtf"]) }));
  assert.equal((await S.view("ann_cf", "u2")).private, true);
  assert.equal((await S.view("ann_cf", null)).private, true);
  assert.ok((await S.view("ann_cf", "u1")).stats, "the owner");
  assert.ok((await S.view("ann_cf", "u9")).stats, "an admin");
  await PL.reset("u1");
  assert.ok((await S.view("ann_cf", null)).stats);
});

test("the page: 1280/375 layout pieces, owner buttons with the price, 404 for private / missing", async () => {
  const render = (v) => ejs.renderFile(path.join(repo, "views", "gtfsheet.ejs"), { user: null, v, signedIn: !!v.owner }, { root: path.join(repo, "views") });
  const owner = await render(await S.view("ann_cf", "u1"));
  assert.match(owner, /data-reroll="sheet" data-price="50000"/);
  assert.match(owner, /data-reroll="avatar" data-price="20000"/);
  assert.match(owner, /28,862,561,789,771,469/, "loot printed exactly");
  assert.match(owner, /cf_use_lockpick\.png/);
  assert.match(owner, /<dialog id="gsConfirm"/);
  const visitor = await render(await S.view("ann_cf", "u2"));
  assert.doesNotMatch(visitor, /data-reroll=/, "only the owner gets the buttons");
  assert.match(visitor, /Pepe right now, so this is his copy/);
  const scripts = [...owner.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const sc of scripts) new Function(sc);
  const miss = await render(await S.view("ghost", null));
  assert.match(miss, /hasn&#39;t rolled a heist sheet yet|hasn't rolled a heist sheet yet/);
});

test("re-roll with GTF data in Pepe: a website action for him (the same chat command), nothing charged here", async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS pepe_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT NOT NULL, camfrog TEXT,
    site_admin INTEGER DEFAULT 0, kind TEXT NOT NULL, args TEXT NOT NULL, tag TEXT, label TEXT, status TEXT NOT NULL DEFAULT 'pending', message TEXT,
    created INTEGER, claimed INTEGER, updated INTEGER, idem TEXT)`).catch(() => {});
  const r = await S.reroll("u1", { what: "sheet", idem: "web-click-0001" });
  assert.equal(r.mode, "pepe");
  const a = (await getQuery("SELECT kind, args, tag FROM pepe_actions WHERE id = ?", [r.queued]))[0];
  assert.deepEqual([a.kind, JSON.parse(a.args), a.tag], ["cmd", ["sheet", "regen"], "gtf"]);
  assert.equal(await bal("u1"), 100000, "Pepe charges it, as in chat");
  await assert.rejects(S.reroll("u2x", { what: "sheet", idem: "web-click-0002" }), /Sign in/);
  await assert.rejects(S.reroll("u9", { what: "sheet", idem: "web-click-0003" }), /Link a chat account/);
});

test("re-roll with GTF data on the site: one keyed transaction - debit + route intent + new sheet + op; never twice", async () => {
  process.env.STAGING = "1";
  const t = { v: 1, sheets: { ann_cf: SHEET }, pvp: { ann_cf: PVP }, lore: "[]" };
  const payload = JSON.stringify(t);
  const imp = await post("/api/gtf/bot/import", { password: "bot", payload, digest: crypto.createHash("sha256").update(payload).digest("hex"), totals: G.totalsOf(t) });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  const r = await S.reroll("u1", { what: "sheet", idem: "site-click-0001" });
  assert.equal(r.mode, "site");
  assert.equal(await bal("u1"), 50000, "charged once, the chat price");
  const intent = (await getQuery("SELECT amount, flow, payer, reason FROM pat_route_intents WHERE key = ?", ["gw-sheet-u1-site-click-0001"]))[0];
  assert.deepEqual(intent, { amount: 50000, flow: "sheetregen", payer: "ann_cf", reason: "sheet-regen" }, "Pepe routes it like the chat command");
  const text = (await getQuery("SELECT data FROM gtf_records WHERE kind = 'sheet' AND id = 'ann_cf'"))[0].data;
  assert.ok(text.includes(`"loot":${BIG}`), "loot untouched past 2^53");
  const nv = JSON.parse(text);
  assert.equal(nv.spent_points, 0);
  assert.deepEqual(nv.rings, []);
  assert.equal(nv.items.kingpinring, 1, "the used ring comes back");
  assert.equal(nv.cracks, 3, "the rest of the record stays (cracks, deepest, done_*, heat, brawls)");
  assert.equal(nv.done_casino, true);
  assert.equal(nv.brawl_wins, 2);
  assert.ok(Object.values(nv.stats).every((x) => x >= 3 && x <= 18));
  assert.equal(nv.class, { str: "Muscle", dex: "Burglar", con: "Wheelman", int: "Hacker", wis: "Lookout", cha: "Face" }[nv.best_stat]);
  assert.deepEqual(r.view.stats.map((s) => s.score), ["str", "dex", "con", "int", "wis", "cha"].map((s) => nv.stats[s]), "the new result comes back at once");
  const again = await S.reroll("u1", { what: "sheet", idem: "site-click-0001" });
  assert.equal(again.already, true);
  assert.equal(await bal("u1"), 50000, "a retry never charges twice");
  // Pepe pushes that sheet before applying the op: deferred, not overwritten
  const put = await post("/api/gtf/bot/put", { password: "bot", key: "gs-race-0001", records: [{ kind: "sheet", id: "ann_cf", json: SHEET }] });
  assert.deepEqual(put.body.deferred, ["ann_cf"]);
  assert.equal((await getQuery("SELECT data FROM gtf_records WHERE kind = 'sheet' AND id = 'ann_cf'"))[0].data, text);
  const ops = (await post("/api/gtf/bot/ops", { password: "bot" })).body.ops;
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, "regen_sheet");
  assert.deepEqual(ops[0].fields.stats, nv.stats);
  assert.equal((await post("/api/gtf/bot/ops/ack", { password: "bot", keys: [ops[0].key] })).body.acked, 1);
  const put2 = await post("/api/gtf/bot/put", { password: "bot", key: "gs-race-0002", records: [{ kind: "sheet", id: "ann_cf", json: text }] });
  assert.equal(put2.body.deferred, undefined, "after the ack Pepe's copy goes in again");
  // avatar: only the seed changes; not enough PAT -> nothing changes
  const av = await S.reroll("u1", { what: "avatar", idem: "site-click-0002" });
  const t2 = (await getQuery("SELECT data FROM gtf_records WHERE kind = 'sheet' AND id = 'ann_cf'"))[0].data;
  assert.notEqual(JSON.parse(t2).avatar_seed, 4242);
  assert.equal(t2.replace(/"avatar_seed":\d+/, ""), text.replace(/"avatar_seed":\d+/, ""), "nothing else changed");
  assert.equal(av.view.avatar.seed, JSON.parse(t2).avatar_seed);
  assert.equal(await bal("u1"), 30000);
  await runQuery("UPDATE users SET points_balance = 10 WHERE userId = 'u1'");
  await assert.rejects(S.reroll("u1", { what: "sheet", idem: "site-click-0003" }), /don't have enough/);
  assert.equal((await getQuery("SELECT data FROM gtf_records WHERE kind = 'sheet' AND id = 'ann_cf'"))[0].data, t2, "refused: the sheet didn't change");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM gtf_ops WHERE key = 'gw-sheet-u1-site-click-0003'"))[0].n, 0);
  await assert.rejects(S.reroll("u2", { what: "sheet", idem: "site-click-0004" }), /don't have a sheet yet/);
});

test("the web endpoint: signed-in, same-site fetch only", async () => {
  cookieUser = null;
  assert.equal((await web("/api/gtf/sheet/reroll", { what: "sheet", idem: "abcdefgh1" })).status, 401);
  cookieUser = "u1";
  assert.equal((await post("/api/gtf/sheet/reroll", { what: "sheet", idem: "abcdefgh1" })).status, 403, "no X-Requested-With");
  cookieUser = null;
});
