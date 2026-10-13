// 1.99wg: the GTF leaderboards (gtfboards.js, /gtf/leaderboards) - computed on the server from the site's GTF records
// (backend live) or Pepe's display mirror (before the cutover), cached briefly.
//   * ranking: loot (exact past 2^53), deepest (then cracks, loot), survival rate (min heists), arena, brawls (W-L, net, W),
//     duels (net, W); ties broken by login so the order is stable
//   * privacy: !incognito (linked: incognito_state; any login: incognito_anon from Pepe's report) and a profile whose GTF
//     section isn't public -> "someone": no name, login, link or avatar anywhere in the page or the API
//   * identity: a linked login shows the account's display name and links /u/<username>; unlinked -> Pepe's name + the sheet
//   * both data sources, the cache, the page (focus board, the viewer's own row past the top 25)
//   NODE_PATH=G:/PATV/node_modules node --test test/gtfboards.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gtfboards-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const G = require(path.join(repo, "gtfstore"));
const S = require(path.join(repo, "gtfsheet"));
const B = require(path.join(repo, "gtfboards"));
const PL = require(path.join(repo, "profilelayout"));
const INC = require(path.join(repo, "incognito"));

const sheet = (o) => JSON.stringify(o);
// loot past 2^53: the two biggest differ only in the last digit (a JS number can't tell them apart)
const MIRROR = {
  ann_cf: `{"avatar_seed":4242,"loot":28862561789771469,"heists":20,"busts":2,"deepest":9,"cracks":3,"arena_wins":4,"brawl_wins":5,"brawl_losses":1,"brawl_net":9000}`,
  bob: `{"avatar_seed":77,"loot":28862561789771468,"heists":12,"busts":0,"deepest":9,"cracks":3,"arena_wins":1,"brawl_wins":2,"brawl_losses":2,"brawl_net":-400}`,
  cat: sheet({ avatar_seed: 5, loot: 5000, heists: 9, busts: 0, deepest: 12, cracks: 0 }),             // 9 heists: below the survival minimum
  dan: sheet({ avatar_seed: 6, loot: 0, heists: 0, busts: 0 }),                                          // on no board
  eve: sheet({ avatar_seed: 8, loot: 700, heists: 10, busts: 1, deepest: 9, cracks: 3, brawl_wins: 3, brawl_losses: 0, brawl_net: 100 }),
  ghost: sheet({ avatar_seed: 9, loot: 9000, heists: 30, busts: 3, deepest: 2, arena_wins: 9 }),         // unlinked + incognito
  hid: sheet({ avatar_seed: 10, loot: 8000, heists: 10, busts: 0, deepest: 1 }),                         // linked, GTF section hidden
};
const PVP = { ann_cf: '{"wins":5,"losses":2,"net":30000}', bob: '{"wins":9,"losses":1,"net":30000}', eve: '{"wins":1,"losses":3,"net":-2500}',
              ghost: '{"wins":2,"losses":0,"net":99999}', dan: '{"wins":0,"losses":0,"net":0}' };
const DISPLAY = { ann_cf: "AnnInChat", bob: "Bobby", cat: "Cat", eve: "Eve", ghost: "GhostName", hid: "HidName" };

let base, server, cookieUser = null;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, text: await r.text() }));
const ids = (rows) => rows.map((r) => (r.anon ? "someone" : r.login));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  for (const [id, name, disp, cf] of [["u1", "ann", "Ann Prime", "Ann_CF"], ["u2", "bob", null, "bob"], ["u3", "eve", "Eve E", "eve"],
                                      ["u4", "hid", "Hidden H", "hid"], ["u9", "nobody", "No Sheet", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES (?, ?, ?, 'x', ?)", [id, name, disp, cf]);
  }
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { if (cookieUser) req.user = { userId: cookieUser, username: cookieUser }; next(); };
  const deps = { isBotToken: (t) => t === "bot", addUser };
  G.register(app, deps);
  S.register(app, deps);
  INC.register(app, deps);
  B.register(app, deps);
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await S.init();
  await INC.init();
  await PL.save("u4", { hidden: ["gtf"] });
});
test.after(() => server && server.close());

test("no data yet: no mode, empty boards, the page says it fills in", async () => {
  B._reset();
  const v = await B.view(null);
  assert.equal(v.mode, null);
  for (const id of B.BOARDS) assert.deepEqual(v.boards[id].rows, []);
  assert.deepEqual(v.periods, ["all"], "all-time only: the sheets keep no per-event times");
  const r = await get("/gtf/leaderboards");
  assert.equal(r.status, 200);
  assert.match(r.text, /fill in as soon as Pepe reports in/);
});

test("Pepe's mirror (before the cutover): every board ranked right", async () => {
  const m = await post("/api/gtf/bot/sheet-mirror", { password: "bot", full: true, sheets: MIRROR, pvp: PVP, display: DISPLAY });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  B._reset();
  const d = await B.compute();
  assert.equal(d.mode, "mirror");
  const L = (id) => d.boards[id].map((r) => r.login);
  // nobody is private yet except hid (profile) - ghost isn't reported incognito yet
  assert.deepEqual(L("loot"), ["ann_cf", "bob", "ghost", null, "cat", "eve"], "loot exact past 2^53 (…469 > …468), 0 left out");
  assert.equal(d.boards.loot[0].loot, "28862561789771469");
  assert.equal(d.boards.loot[1].loot, "28862561789771468");
  assert.deepEqual(L("deep"), ["cat", "ann_cf", "bob", "eve", "ghost", null], "deepest, then cracks, then loot");
  assert.deepEqual(d.boards.deep.map((r) => r.rank), [1, 2, 3, 4, 5, 6]);
  // survival: min 10 heists (cat out); bob 12/12 = 100, hid 10/10 = 100, ghost 27/30 = 90, ann 18/20 = 90, eve 9/10 = 90
  // (same rate -> more heists survived first)
  assert.deepEqual(L("survive"), ["bob", null, "ghost", "ann_cf", "eve"]);
  assert.deepEqual(d.boards.survive.map((r) => r.rate), [100, 100, 90, 90, 90]);
  assert.equal(d.boards.survive[3].survived, "18");
  assert.deepEqual(L("arena"), ["ghost", "ann_cf", "bob"]);
  // brawls: W-L (ann 4, eve 3, bob 0)
  assert.deepEqual(L("brawl"), ["ann_cf", "eve", "bob"]);
  assert.equal(d.boards.brawl[2].net, "-400");
  // duels: net (ghost 99999, then ann / bob tie on 30000 -> more wins first), all-zero record left out
  assert.deepEqual(L("duel"), ["ghost", "bob", "ann_cf", "eve"]);
});

test("identity: linked -> the account's display name + profile link; unlinked -> Pepe's name + the sheet", async () => {
  B._reset();
  const d = await B.compute();
  const ann = d.boards.loot[0], bob = d.boards.loot[1], ghost = d.boards.loot[2], cat = d.boards.loot[4];
  assert.equal(ann.name, "Ann Prime");
  assert.equal(ann.href, "/u/ann");
  assert.equal(ann.seed, 4242);
  assert.equal(bob.name, "bob", "no display name -> the username");
  assert.equal(ghost.name, "GhostName");
  assert.equal(ghost.href, "/gtf/sheet/ghost");
  assert.equal(cat.href, "/gtf/sheet/cat");
});

test("privacy: incognito (linked or not) and a private GTF section are 'someone' with nothing that identifies them", async () => {
  // Pepe's incognito report: eve (linked, a single change) + ghost (unlinked, only in the full list)
  const r = await INC.sync({ items: [{ login: "eve", on: true, via: "chat", ts: Date.now(), changed: false }], full: ["eve", "ghost"] });
  assert.equal(r.applied, 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM incognito_state WHERE login = 'ghost'"))[0].n, 0, "incognito_state still only keeps linked logins");
  B._reset();
  const v = await B.view(null);
  assert.deepEqual(ids(v.boards.loot.rows), ["ann_cf", "bob", "someone", "someone", "cat", "someone"]);
  const json = JSON.stringify(v);
  for (const leak of ["ghost", "GhostName", "eve", "Eve E", "hid", "HidName", "Hidden H", "/u/eve", "/u/hid", "u3", "u4"]) {
    assert.ok(!json.includes(`"${leak}"`) && !json.includes(leak + '"'), "nothing identifies a private player: " + leak);
  }
  for (const row of v.boards.loot.rows.filter((x) => x.anon)) {
    assert.deepEqual(Object.keys(row).filter((k) => ["name", "login", "href", "seed", "sheet"].includes(k) && row[k] != null), []);
  }
  assert.ok(!json.includes("userId"), "account ids never leave the server");
  const api = JSON.parse((await get("/api/gtf/leaderboards")).text);
  assert.equal(api.ok, true);
  assert.equal(api.boards.arena.rows[0].anon, true, "ghost tops the arena as someone");
  const page = (await get("/gtf/leaderboards")).text;
  assert.ok(!/GhostName|Hidden H|HidName|Eve E|\/u\/eve|\/gtf\/sheet\/ghost/.test(page), "the page leaks no private name or link");
  assert.match(page, /someone/);
  assert.match(page, /Ann Prime/);
  // switching incognito off (Pepe's next full list) brings the name back
  await INC.sync({ items: [], full: [] });
  B._reset();
  const v2 = await B.view(null);
  assert.equal(v2.boards.arena.rows[0].name, "GhostName");
  assert.equal(v2.boards.loot.rows[3].anon, true, "hid stays someone: the profile keeps GTF private");
});

test("the GTF records once the backend is live (after the cutover): the site's rows, Pepe's mirror only for names", async () => {
  await G.init();
  for (const [kind, id, data] of [["sheet", "zed", sheet({ avatar_seed: 3, loot: 50, heists: 11, busts: 0, deepest: 3, arena_wins: 2 })],
                                  ["sheet", "ann_cf", MIRROR.ann_cf], ["sheet", "ghost", MIRROR.ghost],
                                  ["sheet", "old", sheet({ loot: 999999 })], ["pvp", "zed", '{"wins":1,"losses":0,"net":10}']]) {
    await runQuery("INSERT INTO gtf_records (kind, id, data, rev, deleted, updated) VALUES (?, ?, ?, 1, ?, 0)", [kind, id, data, id === "old" ? 1 : 0]);
  }
  await G.setMeta("imported", { at: Date.now() });
  B._reset();
  const d = await B.compute();
  assert.equal(d.mode, "site");
  assert.deepEqual(d.boards.loot.map((r) => r.login), ["ann_cf", "ghost", "zed"], "only live rows (deleted ones and mirror-only players gone)");
  assert.equal(d.boards.loot[1].name, "GhostName", "an unlinked login keeps Pepe's display name from the mirror");
  assert.deepEqual(d.boards.duel.map((r) => r.login), ["zed"]);
  assert.deepEqual(d.boards.survive.map((r) => r.login), ["zed", "ghost", "ann_cf"]);
  const page = (await get("/gtf/leaderboards")).text;
  assert.ok(!/Pepe&#39;s copy/.test(page), "no 'Pepe's copy' note when the site owns the data");
  await G.setMeta("released", { at: Date.now() });
  B._reset();
  assert.equal((await B.compute()).mode, "mirror", "released back to Pepe -> the mirror again");
  await runQuery("DELETE FROM gtf_meta WHERE key IN ('imported', 'released')");
});

test("cached for a minute", async () => {
  let t = 1e12;
  B._setClock(() => t);
  const a = await B.data();
  await post("/api/gtf/bot/sheet-mirror", { password: "bot", sheets: { newbie: sheet({ loot: 10 ** 15 }) }, display: { newbie: "Newbie" } });
  t += 30e3;
  assert.equal(await B.data(), a, "still the cached boards");
  t += B.BOARD_TTL_MS;
  const b = await B.data();
  assert.equal(b.boards.loot[2].login, "newbie", "recomputed after the TTL");
  B._setClock(() => Date.now());
});

test("the page: every board, links, the focus board first, your own row past the top 25", async () => {
  const many = {};
  for (let i = 0; i < 30; i++) many["p" + String(i).padStart(2, "0")] = sheet({ loot: 10 ** 12 + i, heists: 1 });
  await post("/api/gtf/bot/sheet-mirror", { password: "bot", sheets: many });
  await runQuery("UPDATE users SET camfrogUsername = 'p00' WHERE userId = 'u9'");
  B._reset();
  cookieUser = "u9";
  const api = JSON.parse((await get("/api/gtf/leaderboards")).text);
  assert.equal(api.boards.loot.rows.length, B.TOP);
  assert.ok(api.boards.loot.me && api.boards.loot.me.mine && api.boards.loot.me.rank > B.TOP, "the viewer's own row past the top 25");
  const r = await get("/gtf/leaderboards?board=duel");
  assert.equal(r.status, 200);
  const page = r.text;
  assert.ok(page.indexOf('id="duel"') < page.indexOf('id="loot"'), "?board=duel puts the duel board first");
  assert.match(page, /class="card violet focus" id="duel"/);
  for (const id of B.BOARDS) assert.match(page, new RegExp(`id="${id}"`));
  assert.match(page, /href="\/gtf\/gangs"/);
  assert.match(page, /href="\/u\/ann"/);
  assert.match(page, /data-seed="4242"/, "podium avatars");
  assert.match(page, /ALL-TIME/);
  assert.match(page, /YOU/);
  cookieUser = null;
});

test("/gtf links the leaderboards (no more Netlify heist board)", () => {
  const GTF = require(path.join(repo, "gtf"));
  assert.equal(GTF.LINKS.heistBoard, "/gtf/leaderboards");
  const layout = fs.readFileSync(path.join(repo, "views", "layout.ejs"), "utf8");
  assert.match(layout, /'\/gtf\/leaderboards'/, "in the nav");
  const help = JSON.parse(fs.readFileSync(path.join(repo, "data", "help-commands.json"), "utf8"));
  assert.ok(!JSON.stringify(help).includes("pepe.publicaccess.tv/heist"), "the help data no longer points at the Netlify board");
});
