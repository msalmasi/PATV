// h22 phase 2 (1.99??): the scheduled tournaments' HTTP surface (casino/routes.js): JSON fetch + X-Requested-With on every POST, the
// 401 / 403 / 404 / 409 / 429 answers, admin routes behind casino.admin (each one audited) and the owner-only ones (void, overlay retry),
// the settings' bounds, Pepe's !mtt verbs (game "mtt", two args), a room player's bare Hold'em verb resolved turn-first, Telegram refused,
// BOT_VERBS, the pages, and the MTT table view's 1 s public cache keyed by the table's rev.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { harness } = require("./fixtures/mtt-harness");
const h = harness("casino-mtt-routes");
const { svc, MT, H, getQuery, runQuery } = h;
const routes = require(path.join(h.repo, "casino", "routes"));
require(path.join(h.repo, "staffroles")).ownerOf = async (u) => (u && u.userId === "ad" ? { userId: "ad", username: "ada" } : null);

let server, base;
// (each account on its own address: two accounts from one address can't both enter - that rule is tested in casino-mtt.test.js)
const hdr = (uid, extra) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", "x-forwarded-for": "10.1.0." + (uid ? String(uid).replace(/\D/g, "") || "200" : "99") },
                                          uid ? { "x-test-user": uid } : {}, extra || {});
const post = async (url, body, uid, extra) => { const r = await fetch(base + url, { method: "POST", headers: hdr(uid, extra), body: JSON.stringify(body) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const get = async (url, uid) => { const r = await fetch(base + url, { headers: hdr(uid), redirect: "manual" }); return { status: r.status, j: await r.json().catch(() => null), loc: r.headers.get("location") }; };
let k = 0;
const idem = () => "routes-idem-" + String(++k).padStart(4, "0");
const bot = (body) => post("/api/casino/bot/act", Object.assign({ password: "bot-pw", idem: idem(), room: "PepeLab" }, body));

test.before(async () => {
  await h.setup(30);
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

test("web: register / unregister / remind need JSON fetch, a sign-in and a known tournament; 401 / 403 (switch) / 404 / 409 / 429", async () => {
  await h.fresh();
  const M = await h.schedule({ max_entries: 3, min_entries: 2 });
  let r = await fetch(base + `/api/casino/mtt/${M.id}/register`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "u1" }, body: JSON.stringify({ idem: idem() }) });
  assert.equal(r.status, 400, "no X-Requested-With");
  assert.equal((await post(`/api/casino/mtt/${M.id}/register`, { idem: idem() }, null)).status, 401);
  assert.equal((await post(`/api/casino/mtt/m000000000/register`, { idem: idem() }, "u1")).status, 404);
  let x = await post(`/api/casino/mtt/${M.id}/register`, { idem: idem(), remind: true }, "u1");
  assert.equal(x.status, 200, JSON.stringify(x.j));
  assert.match(x.j.reply, /You're in/);
  x = await post(`/api/casino/mtt/${M.id}/unregister`, { idem: idem() }, "u1");
  assert.equal(x.status, 200);
  x = await post(`/api/casino/mtt/${M.id}/register`, { idem: idem() }, "u1");
  assert.equal(x.status, 429, "one MTT op per user per 2 s");
  h.NOW += 2500;
  for (const u of ["u1", "u2", "u3"]) { const y = await post(`/api/casino/mtt/${M.id}/register`, { idem: idem() }, u); assert.equal(y.status, 200, u); }
  x = await post(`/api/casino/mtt/${M.id}/register`, { idem: idem() }, "u4");
  assert.equal(x.status, 409, "full");
  await svc.setSetting("casino_mtt", "off", "test");
  x = await post(`/api/casino/mtt/${M.id}/register`, { idem: idem() }, "u5");
  assert.equal(x.status, 403);
  // the views: entrants keep them, others are told no / sent back to the lobby
  assert.equal((await get(`/api/casino/mtt/${M.id}`, "u1")).status, 200);
  assert.equal((await get(`/api/casino/mtt/${M.id}`, "u9")).status, 403);
  const page = await get(`/casino/holdem/mtt/${M.id}`, "u9");
  assert.equal(page.status, 302);
  assert.equal(page.loc, "/casino/holdem");
  assert.equal((await get(`/casino/holdem/mtt/${M.id}`, "u1")).status, 200, "an entrant's page");
  await svc.setSetting("casino_mtt", "everyone", "test");
  const lob = await get("/api/casino/lobby", "u1");
  assert.ok(lob.j.mtt && lob.j.mtt.mtt_on, "the lobby carries the 🏆 block");
  const me = await get(`/api/casino/mtt/${M.id}/me`, "u1");
  assert.equal(me.j.me.registered, true);
  assert.equal(me.j.me.remind, false);
  assert.ok(!JSON.stringify(me.j).includes('"u1"'), "no account ids");
});

test("admin: casino.admin only, every action audited; void / overlay retry need the owner role; settings validated to their bounds", async () => {
  await h.fresh();
  const form = { title: "Admin Cup", start_at: h.NOW + 3600e3, buyin: 1000, min_entries: 2, max_entries: 20 };
  assert.equal((await post("/api/casino/admin/mtt", form, "u1")).status, 403);
  assert.equal((await post("/api/casino/admin/mtt", form, null)).status, 401);
  const c = await post("/api/casino/admin/mtt", form, "ad");
  assert.equal(c.status, 200, JSON.stringify(c.j));
  const id = c.j.ids[0];
  assert.equal((await post("/api/casino/admin/mtt", Object.assign({}, form, { title: "X" }), "ad")).status, 400, "a bad title");
  assert.equal((await post(`/api/casino/admin/mtt/${id}/delay`, { minutes: 15 }, "ad")).status, 200);
  assert.equal((await post(`/api/casino/admin/mtt/${id}/void`, { confirm: true, reason: "x" }, "st")).status, 403);
  assert.equal((await post(`/api/casino/admin/mtt/${id}/void`, { confirm: true, reason: "x" }, "ad")).status, 409, "the owner, but not finishing");
  assert.equal((await post(`/api/casino/admin/mtt/${id}/overlay-retry`, {}, "ad")).status, 409);
  assert.equal((await post(`/api/casino/admin/mtt/${id}/nope`, {}, "ad")).status, 404);
  assert.equal((await post(`/api/casino/admin/mtt/${id}/cancel`, { confirm: false }, "ad")).status, 400);
  assert.equal((await post(`/api/casino/admin/mtt/${id}/cancel`, { confirm: true, reason: "test" }, "ad")).status, 200);
  const acts = (await getQuery("SELECT action FROM admin_audit WHERE action LIKE 'casino_mtt_%'")).map((r) => r.action);
  for (const a of ["casino_mtt_create", "casino_mtt_delay", "casino_mtt_cancel"]) assert.ok(acts.includes(a), a);
  const list = await get("/api/casino/admin/mtt", "ad");
  assert.ok(list.j.ok && list.j.gate && /locked until 2026-12-01 14:00 UTC/.test(list.j.gate.text), JSON.stringify(list.j.gate));
  // settings: each key's bounds (validated + normalised; a bad value refused)
  const bad = [["casino_mtt", "maybe"], ["mtt_fee_pct", "51"], ["mtt_table_size", "7"], ["mtt_start_chips", "499"], ["mtt_next_secs", "1"], ["mtt_late_levels", "21"],
               ["mtt_reentry_cap", "4"], ["mtt_max_field", "501"], ["mtt_paid_pct", "4"], ["mtt_curve_exp", "2"], ["mtt_overlay_cap", "1000000"], ["mtt_budget_group", "turf"],
               ["mtt_stream_final", "always"], ["mtt_discord_channel", "abc"], ["mtt_discord_kinds", "starting,spam"], ["mtt_payouts_small", "100|60,30|50,30,20"], ["mtt_levels", "20/10"]];
  for (const [key, value] of bad) assert.equal((await post("/api/casino/admin/settings", { key, value }, "ad")).status, 400, key);
  const good = [["mtt_fee_pct", "0"], ["mtt_table_size", "6"], ["mtt_curve_exp", "1.25"], ["mtt_overlay_cap", "999999"], ["mtt_discord_kinds", "reg_open,winner"], ["mtt_buyins", "2k,10k"]];
  for (const [key, value] of good) { const r = await post("/api/casino/admin/settings", { key, value }, "ad"); assert.equal(r.status, 200, key + " " + JSON.stringify(r.j)); }
  assert.equal(svc.S.settings.mtt_buyins, "2000,10000");
  assert.equal((await post("/api/casino/admin/settings", { key: "mtt_fee_pct", value: "5" }, "u1")).status, 403);
});

test("Pepe: !mtt verbs (game mtt, two args) - list, info, join, remind, me, top, leave; pause / resume / cancel only with casino.admin on the linked account; Telegram refused; BOT_VERBS", async () => {
  await h.fresh();
  const M = await h.schedule({ max_entries: 20, min_entries: 2 });
  const pl = h.players;
  let r = await bot({ username: pl[0].username, camfrog: "AnnCF", game: "mtt", verb: "list", args: [] });
  assert.ok(r.j.ok);
  assert.match(r.j.reply, new RegExp(`#${M.no} Sunday Stack`));
  r = await bot({ username: pl[0].username, camfrog: "AnnCF", game: "mtt", verb: "info", args: [String(M.no)] });
  assert.match(r.j.reply, /registered/);
  r = await bot({ username: pl[0].username, camfrog: "AnnCF", game: "mtt", verb: "join", args: [String(M.no), "remind", "extra"] });
  assert.ok(r.j.ok, r.j.reply);
  r = await bot({ username: pl[0].username, camfrog: "AnnCF", game: "mtt", verb: "remind", args: [String(M.no), "off"] });
  assert.match(r.j.reply, /No reminder/);
  r = await bot({ username: pl[0].username, camfrog: "AnnCF", game: "mtt", verb: "me", args: [] });
  assert.ok(r.j.pm, "!mtt me is private");
  assert.match(r.j.reply, /registered/);
  r = await bot({ username: pl[1].username, game: "mtt", verb: "pause", args: [String(M.no)], admin: true });
  assert.equal(r.j.ok, false, "a Pepe room admin without casino.admin");
  r = await bot({ username: "ada", game: "mtt", verb: "cancel", args: [String(M.no)] });
  assert.match(r.j.reply, /confirm/);
  r = await post("/api/casino/bot/act", { password: "bot-pw", idem: idem(), room: "PepeLab", username: pl[0].username, game: "mtt", verb: "list", channel: "telegram" });
  assert.equal(r.status, 403);
  for (const v of ["reenter", "remind", "me", "top", "standings", "pause", "resume", "schedule", "list", "join", "leave", "info", "cancel", "help"]) assert.ok(routes.BOT_VERBS.has(v), v);
  r = await bot({ username: pl[0].username, game: "mtt", verb: "leave", args: [String(M.no)] });
  assert.ok(r.j.ok);
  h.NOW += 2500;
  await h.reg(M, pl.slice(1, 5));
  await h.toStart(M);
  r = await bot({ username: pl[1].username, game: "mtt", verb: "top", args: [String(M.no)] });
  assert.match(r.j.reply, /4 left/);
  r = await bot({ username: "ada", game: "mtt", verb: "pause", args: [String(M.no)] });
  assert.ok(r.j.ok, r.j.reply);
  assert.ok(M.paused);
  r = await bot({ username: "ada", game: "mtt", verb: "resume", args: [String(M.no)] });
  assert.ok(r.j.ok);
});

test("a room player's bare Hold'em verb: the table where it's their turn first; their room's table; the only tournament table; two turns at once = use the web", async () => {
  await h.fresh();
  const M = await h.schedule({ max_entries: 20, min_entries: 2 });
  const pl = h.players;
  await h.reg(M, pl.slice(0, 3));
  await h.toStart(M);
  await h.later(7);
  const T = MT.liveTables(M)[0];
  const a = H.currentActor(T.eng);
  const who = h.byUid[a];
  // a cash table in the room where the same player also sits (between hands)
  svc.noteRooms([{ id: "PepeLab", name: "PepeLab" }]);
  const cash = await h.act(Object.assign({}, pl[10], { via: "room", room: "PepeLab" }), "start", ["25/50"], { game: "holdem", room: "PepeLab" });
  const C = svc.getTable(cash.table);
  require(path.join(h.repo, "casino", "hmengine")).sit(C.eng, a, who.name, 2000);
  assert.equal(svc.tourneyTableFor(a, "PepeLab").T.id, T.id, "turn first: the MTT table");
  const r = await bot({ username: who.username, game: "holdem", verb: H.toCall(T.eng, a) ? "call" : "check", args: [] });
  assert.ok(r.j.ok, r.j.reply);
  assert.equal(r.j.quiet, true, "quiet on success at an MTT table");
  // it's nobody's turn of theirs: the room's table (they sit there)
  const f = svc.tourneyTableFor(a, "PepeLab");
  if (!T.eng.hand_active || H.currentActor(T.eng) !== a) assert.equal(f.T.id, C.id, "their room's table");
  // their turn at both: ambiguous
  C.eng.hand_active = true; C.eng.actor = a;
  T.eng.hand_active = true; const keep = T.eng.actor; T.eng.actor = a;
  assert.match(svc.tourneyTableFor(a, "PepeLab").err, /more than one table/);
  C.eng.hand_active = false; C.eng.actor = null; T.eng.actor = keep;
});

test("an MTT table's public view is cached a second per (table, rev); refreshVeil loops skip MTT tables", async () => {
  await h.fresh();
  const M = await h.schedule({ max_entries: 20, min_entries: 2 });
  await h.reg(M, h.players.slice(0, 3));
  await h.toStart(M);
  const T = MT.liveTables(M)[0];
  const a = await get(`/api/casino/t/${T.id}`, "u1");
  assert.ok(a.j.table.tourney && a.j.table.tourney.kind === "mtt");
  const rev = T.rev;
  T.eng.names[T.eng.seats[0]] = "Renamed";                    // a change without a save: the cached view (same rev) is served
  const b = await get(`/api/casino/t/${T.id}`, "u1");
  assert.ok(!JSON.stringify(b.j.table).includes("Renamed"), "cached for the same rev");
  await svc.locked(() => require(path.join(h.repo, "casino", "service")).S && null);
  T.rev = rev + 1;
  const c = await get(`/api/casino/t/${T.id}`, "u1");
  assert.ok(JSON.stringify(c.j.table).includes("Renamed"), "a new rev: a fresh view");
  assert.ok(c.j.me && c.j.me.tourney, "me is per request");
});
