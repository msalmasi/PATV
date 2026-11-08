// h22 phase 2 (1.99amj), the rebase onto site 1.99amh (hand-off 20's card table themes, 1.99amf, landed first): which theme a SCHEDULED
// tournament's table gets. The themes brief keeps tournaments out of its scope (G:/ops/handoffs/20-poker-themes.md "Out of scope": hand-off
// 22) and says nothing else about them; hand-off 20's own rebase onto h22 made a Sit & Go table classic (casino/tourney.js builds it with
// HM.newTable(..., { tourney: true }) - no opts.theme, and the Create sheet offers no theme). So an MTT table takes the SAME path
// (casino/mtt.js newTableInTx: HM.newTable(..., { tourney: true })), and this file proves it ends where a Sit & Go table's does:
//   * the stored theme (T.theme) is a valid registry id - classic - at every casino_themes value (off | staff | everyone), as a Sit & Go's;
//     a restart keeps it
//   * every surface that carries a table's theme carries an MTT table's exactly like a Sit & Go table's: publicView, GET /api/casino/t/:id,
//     Pepe's board (the bot poll's `tables`: the final table on the stream slot, the Sit & Go in its room) and the table page's theme files
//     (/casino/holdem/t/:id: classic = none of them); with a theme on the table object both show it the same way (one pipeline)
//   * the browser: casinohm.js render dresses an MTT table through the one CZ.theme call after sngHead (the MTT header returns from
//     sngHead only, never from render) - the felt's scene and sign the same way as at a Sit & Go
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { harness } = require("./fixtures/mtt-harness");
const h = harness("casino-mtt-theme");
const { svc, MT } = h;
const themes = require(path.join(h.repo, "casino", "themes"));
const routes = require(path.join(h.repo, "casino", "routes"));

let server, base;
const hdr = (uid) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, uid ? { "x-test-user": uid } : {});
const getJ = async (url, uid) => (await fetch(base + url, { headers: hdr(uid) })).json();
const page = async (url, uid) => (await fetch(base + url, { headers: hdr(uid) })).text();
// Pepe's poll as a build that knows tournaments (`scene` in the body) - after: -1 answers at once with the board's tables
const board = async () => (await fetch(base + "/api/casino/bot/poll", { method: "POST", headers: hdr(null),
  body: JSON.stringify({ password: "bot-pw", after: -1, scene: { held: false }, rooms: [{ id: "PepeLab", name: "PepeLab" }] }) })).json();
const THEMED = ["/public/css/casino-themes.css?v=", 'id="cz-theme-saloon"', "/public/js/casino-sound.js?v="];

test.before(async () => {
  await h.setup(12);
  await h.fresh();
  const express = require(path.join(h.repo, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.set("views", path.join(h.repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; const u = req.get("x-test-user"); req.user = u ? { userId: u, username: u } : null; next(); });
  routes.register(app, { isBotToken: (p) => p === "bot-pw", addUser: (req, res, next) => next(), discordBridge: async () => ({ ok: true }) });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { svc.stop(); if (server) { server.closeAllConnections(); server.close(); } });

/** a running 4-entry MTT (one table = the final table, on Pepe's stream slot) + a running 2-seat Sit & Go in PepeLab -> [F, G] */
async function bothTables() {
  await h.fresh({ settings: { casino_sng: "everyone" } });
  svc.noteRooms([{ id: "PepeLab", name: "PepeLab" }]);
  const P = h.players;
  const M = await h.schedule({ max_entries: 6, min_entries: 2, table_size: 9, late_levels: 0 });
  await h.reg(M, P.slice(0, 4));
  await h.toStart(M);
  assert.equal(M.status, "running");
  const F = MT.liveTables(M)[0];
  assert.equal(svc.S.stream.table, F.id, "the final table is on Pepe's stream slot (so it is on his board)");
  const s = await h.act(P[6], "new", ["2", "1k"], { game: "sng", room: "PepeLab" });
  assert.ok(s.ok, s.reply);
  h.NOW += 2100;
  const j = await h.act(P[7], "join", [s.table], { game: "sng", room: "PepeLab" });
  assert.ok(j.ok, j.reply);
  const G = svc.getTable(s.table);
  assert.equal(svc.tourneyKind(F), "mtt");
  assert.equal(svc.tourneyKind(G), "sng");
  return { M, F, G };
}

test("an MTT table's theme = a Sit & Go table's (classic, a valid registry id) at every casino_themes value: stored, publicView, the table API, Pepe's board, the page; a restart keeps it", async () => {
  const { M, F, G } = await bothTables();
  for (const mode of ["off", "staff", "everyone"]) {
    await svc.setSetting("casino_themes", mode, "test");
    await svc.loadSettings(true);
    for (const [label, T] of [["mtt", F], ["sng", G]]) {
      assert.equal(T.theme, "classic", `${mode}: the ${label} table is stored classic`);
      assert.ok(Object.hasOwn(themes.THEMES, T.theme) && themes.offers(T.theme, "holdem"), `${mode}: ${label}: a theme drawn for Hold'em`);
      assert.equal(svc.publicView(T).theme, "classic", `${mode}: ${label}: publicView`);
      assert.equal((await getJ(`/api/casino/t/${T.id}`, "u1")).table.theme, "classic", `${mode}: ${label}: GET /api/casino/t/:id`);
    }
    const b = await board();
    assert.ok(b.ok && b.tables[F.id] && b.tables[G.id], `${mode}: both tables on Pepe's board`);
    assert.equal(b.tables[F.id].theme, b.tables[G.id].theme, `${mode}: the board carries the MTT table's theme like the Sit & Go's`);
    assert.equal(b.tables[F.id].theme, "classic");
    assert.equal(b.tables[F.id].tourney.kind, "mtt");
    for (const [label, T] of [["mtt", F], ["sng", G]]) {
      const html = await page(`/casino/holdem/t/${T.id}`, "u1");
      assert.ok(html.includes(`data-table="${T.id}"`), `${mode}: ${label}: the table page`);
      for (const s of THEMED) assert.ok(!html.includes(s), `${mode}: ${label}: a classic table's page loads no ${s}`);
    }
  }
  // no dealer flavour at either (classic): the tables' logs carry no saloon line
  for (const T of [F, G]) assert.ok(!T.log.some((l) => /🤠/.test(l.text)), "no saloon flavour line");
  // restart-safe: the recovered tables read the same
  await h.restart();
  const F2 = MT.liveTables(svc.S.mtts.get(M.id))[0], G2 = svc.getTable(G.id);
  assert.equal(F2.id, F.id);
  for (const T of [F2, G2]) { assert.equal(T.theme, "classic"); assert.equal(svc.publicView(T).theme, "classic"); }
  await svc.setSetting("casino_themes", "off", "test");
});

test("one pipeline: a theme on the table object shows at an MTT table exactly as at a Sit & Go table (publicView, the table API, Pepe's board, the page's theme files) and reads classic when the switch goes off", async () => {
  const { F, G } = await bothTables();
  await svc.setSetting("casino_themes", "everyone", "test");
  await svc.loadSettings(true);
  F.theme = G.theme = "saloon";              // (no tournament opens themed - this only checks what every surface does with the field)
  try {
    const b = await board();
    for (const [label, T] of [["mtt", F], ["sng", G]]) {
      assert.equal(svc.publicView(T).theme, "saloon", `${label}: publicView`);
      assert.equal((await getJ(`/api/casino/t/${T.id}`, "u1")).table.theme, "saloon", `${label}: the table API`);
      assert.equal(b.tables[T.id].theme, "saloon", `${label}: Pepe's board`);
      const html = await page(`/casino/holdem/t/${T.id}`, "u1");
      for (const s of THEMED) assert.ok(html.includes(s), `${label}: the themed page loads ${s}`);
    }
    await svc.setSetting("casino_themes", "off", "test");
    await svc.loadSettings(true);
    const b2 = await board();
    for (const [label, T] of [["mtt", F], ["sng", G]]) {
      assert.equal(svc.publicView(T).theme, "classic", `${label}: off = classic`);
      assert.equal(b2.tables[T.id].theme, "classic", `${label}: off = classic on the board`);
      const html = await page(`/casino/holdem/t/${T.id}`, "u1");
      for (const s of THEMED) assert.ok(!html.includes(s), `${label}: off = no ${s}`);
    }
  } finally { F.theme = G.theme = "classic"; }
});

test("the browser: casinohm.js render dresses an MTT table through the same one CZ.theme call as a Sit & Go table (the MTT header returns from sngHead only)", () => {
  const hm = fs.readFileSync(path.join(h.repo, "public", "js", "casinohm.js"), "utf8");
  const body = (name) => {
    const i = hm.indexOf(`\n  function ${name}(`);
    assert.ok(i > 0, name);
    const j = hm.indexOf("\n  function ", i + 1);
    return hm.slice(i, j > i ? j : undefined);
  };
  const render = body("render"), head = body("sngHead");
  assert.equal((hm.match(/CZ\.theme\(/g) || []).length, 1, "one CZ.theme call");
  const iHead = render.indexOf("sngHead(t, me);"), iTheme = render.indexOf('CZ.theme(t, { scene: $("cz-felt").parentNode, sign: $("cz-seats") });');
  assert.ok(iHead > 0 && iTheme > iHead, "render: the header first, then the theme - for every table");
  assert.ok(!/\breturn\b/.test(render.slice(iHead, iTheme)), "nothing between the header and the theme returns early (an MTT table included)");
  assert.ok(!head.includes("CZ.theme("), "sngHead never dresses the table itself");
  assert.match(head, /if \(tn\.kind === "mtt"\) \{[\s\S]*?window\.CZMTT\.tableHead\(t, me, head, res\);\s*return;\s*\}/, "the MTT header returns from sngHead");
  // the page's theme files follow the table's theme only (routes.js page: themes.themeOf) - no tournament branch of its own
  const rt = fs.readFileSync(path.join(h.repo, "casino", "routes.js"), "utf8");
  assert.match(rt, /theme: T \? themes\.themeOf\(T, st\) : "classic"/);
});
