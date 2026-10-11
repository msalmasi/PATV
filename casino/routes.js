// casino/routes.js — the casino backend's HTTP API and pages (1.99lj; docs/casino-backend.md).
//
// Web (a signed-in PATV account; no Camfrog link needed):
//   GET  /casino/blackjack[/t/:id]          the page (lobby + table)
//   GET  /api/casino/bj/lobby               open tables, the rooms a table can be pushed to, the switch
//   GET  /api/casino/bj/t/:id               one table's public state + the viewer's own seat (per-user: never cached)
//   POST /api/casino/bj/open                open a web-only table
//   POST /api/casino/bj/t/:id/act           {verb, amount?, idem}  bet / autobet / deal / hit / stand / double / split /
//                                            insurance / leave / end / status
//   POST /api/casino/bj/t/:id/push          {room|null}  push the table to a Camfrog room Pepe serves (host or admin)
//   GET  /casino/fair/:id/:round + /api/casino/fair/:id/:round    the fairness proof of a round
//   POST /api/casino/admin/settings         {key, value}  bj_enabled / max_tables (site Admin, or the bot token)
// Pepe (bot token in the body):
//   POST /api/casino/bot/poll               {after, wait, rooms}  long-poll the events of tables in rooms (cursor)
//   POST /api/casino/bot/act                {room|table, username, camfrog, name, verb, args, idem, channel, admin}
// Web POSTs are JSON with X-Requested-With: fetch (a cross-site form can't send them). Telegram never reaches here:
// gambling stays off the Telegram bridge (channel "telegram" is refused).
"use strict";
const path = require("path");
const { getQuery } = require("../dbUtils");
const svc = require("./service");

const WEB_VERBS = new Set(["bet", "autobet", "deal", "hit", "stand", "double", "split", "insurance", "leave", "end", "status"]);
const BOT_VERBS = new Set(["start", "bet", "autobet", "deal", "hit", "stand", "double", "split", "insurance", "leave", "end", "status",
                           "help", "open", "new", "go", "wager", "auto", "rebet", "close", "stop", "quit", "insure", "stay", "dd",
                           "table", "info", "show", "rules", "how", ""]);
const ID = /^[0-9a-f]{10}$/;
const IDEM = /^[\w:.\-]{8,100}$/;

function clientIp(req) {
  try { return require("../middleware/authGuard").clientIp(req); } catch (e) { return req.ip || null; }
}
const isJsonFetch = (req) => req.is("application/json") && req.get("X-Requested-With") === "fetch";

async function webActor(req) {
  if (!req.user || !req.user.userId) return null;
  const u = (await getQuery("SELECT userId, username, displayname, camfrogUsername, class FROM users WHERE userId = ?", [req.user.userId]))[0];
  if (!u) return null;
  return { uid: u.userId, name: u.displayname || u.username, username: u.username, camfrog: u.camfrogUsername || null, via: "web",
           iph: svc.ipHash(clientIp(req)), admin: u.class === "Admin" };
}

function register(app, { isBotToken, addUser }) {
  const boot = () => svc.boot().catch((e) => console.error("[casino] boot:", e));
  setImmediate(boot);

  // ── pages ──
  const page = async (req, res) => {
    const id = req.params && req.params.id ? String(req.params.id) : null;
    if (id && !ID.test(id)) return res.redirect("/casino/blackjack");
    await svc.boot();
    const st = await svc.loadSettings();
    if (!st.bj_enabled && !(id && svc.getTable(id))) return res.redirect("/blackjack");
    res.locals.og = { title: "Blackjack with Pepe — publicaccess.tv",
                      description: "Pepe deals blackjack on the web: sit down with your PAT, no Camfrog needed — or play the same table from a Camfrog room.",
                      image: (res.locals.ogBase || "") + "/og/page.png?t=" + encodeURIComponent("Blackjack"), url: (res.locals.ogBase || "") + (res.locals.ogPath || "") };
    res.render("casino-bj", { user: req.user ? req.user.username : null, signedIn: !!(req.user && req.user.userId), tableId: id,
                              title: "Blackjack" });
  };
  app.get("/casino/blackjack", addUser, page);
  app.get("/casino/blackjack/t/:id", addUser, page);

  app.get("/casino/fair/:id/:round", addUser, async (req, res) => {
    res.render("casino-fair", { user: req.user ? req.user.username : null, title: "Blackjack fairness",
                                tableId: ID.test(req.params.id) ? req.params.id : "", round: Math.trunc(Number(req.params.round) || 0) });
  });

  // ── web API ──
  app.get("/api/casino/bj/lobby", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    await svc.boot();
    const st = await svc.loadSettings();
    const actor = await webActor(req);
    res.json({ enabled: st.bj_enabled, tables: svc.lobby(), rooms: svc.freshRooms(), max_tables: st.max_tables,
               me: actor ? { name: actor.name, admin: actor.admin } : null });
  });

  app.get("/api/casino/bj/t/:id", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!ID.test(req.params.id)) return res.status(404).json({ ok: false, error: "No such table." });
    await svc.boot();
    const T = svc.getTable(req.params.id);
    if (!T) return res.status(404).json({ ok: false, error: "That table has closed." });
    const out = { ok: true, now: Date.now(), table: svc.publicView(T), rooms: svc.freshRooms() };
    out.me = req.user && req.user.userId ? await svc.meView(T, req.user.userId) : null;
    res.json(out);
  });

  app.post("/api/casino/bj/open", addUser, async (req, res) => {
    if (!isJsonFetch(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    const actor = await webActor(req);
    if (!actor) return res.status(401).json({ ok: false, error: "Sign in to play." });
    const idem = String((req.body || {}).idem || "");
    if (!IDEM.test(idem)) return res.status(400).json({ ok: false, error: "Bad request." });
    const out = await svc.act(actor, "start", [], { room: null }, `web-${actor.uid}-${idem}`);
    res.status(out.ok ? 200 : 409).json(out);
  });

  app.post("/api/casino/bj/t/:id/act", addUser, async (req, res) => {
    if (!isJsonFetch(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    const actor = await webActor(req);
    if (!actor) return res.status(401).json({ ok: false, error: "Sign in to play." });
    const b = req.body || {};
    const verb = String(b.verb || "").toLowerCase();
    const idem = String(b.idem || "");
    if (!ID.test(req.params.id) || !WEB_VERBS.has(verb) || !IDEM.test(idem)) return res.status(400).json({ ok: false, error: "That can't be done." });
    const args = b.amount == null ? [] : [String(b.amount).slice(0, 14)];
    const out = await svc.act(actor, verb, args, { table: req.params.id }, `web-${actor.uid}-${idem}`);
    res.json(out);
  });

  app.post("/api/casino/bj/t/:id/push", addUser, async (req, res) => {
    if (!isJsonFetch(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    const actor = await webActor(req);
    if (!actor) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (!ID.test(req.params.id)) return res.status(404).json({ ok: false, error: "No such table." });
    const room = (req.body || {}).room ? String(req.body.room).slice(0, 64) : null;
    res.json(await svc.push(req.params.id, room, actor));
  });

  app.get("/api/casino/fair/:id/:round", async (req, res) => {
    if (!ID.test(req.params.id)) return res.status(404).json({ ok: false });
    const rec = await svc.fairRecord(req.params.id, req.params.round);
    if (!rec) return res.status(404).json({ ok: false, error: "No such round." });
    res.json(Object.assign({ ok: true }, rec));
  });

  app.post("/api/casino/admin/settings", addUser, async (req, res) => {
    const b = req.body || {};
    let actor = null;
    if (isBotToken(b.password)) actor = "pepe:" + String(b.actor || "bot").slice(0, 40);
    else if (isJsonFetch(req) && req.user && req.user.userId) {
      const u = (await getQuery("SELECT username, class FROM users WHERE userId = ?", [req.user.userId]))[0];
      if (u && u.class === "Admin") actor = u.username;
    }
    if (!actor) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      const st = await svc.setSetting(String(b.key || ""), b.value, actor);
      console.log(`[casino] setting ${b.key} = ${b.value} by ${actor}`);
      res.json({ ok: true, settings: st });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // ── Pepe ──
  app.post("/api/casino/bot/poll", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    svc.noteRooms(b.rooms);
    const wait = Math.max(0, Math.min(8, Number(b.wait) || 0)) * 1000;
    try {
      const st = await svc.loadSettings();
      const out = await svc.poll(b.after, wait);
      res.json(Object.assign({ ok: true, enabled: st.bj_enabled }, out));
    } catch (e) {
      console.error("[casino] poll:", e);
      res.status(500).json({ ok: false, events: [] });
    }
  });

  app.post("/api/casino/bot/act", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    if (String(b.channel || "") === "telegram") return res.status(403).json({ ok: false, reply: "the casino isn't on Telegram." });
    const verb = String(b.verb || "").toLowerCase();
    const idem = String(b.idem || "");
    if (!BOT_VERBS.has(verb) || !IDEM.test(idem)) return res.status(400).json({ ok: false, reply: "bad request" });
    const u = (await getQuery("SELECT userId, username, displayname, camfrogUsername, class FROM users WHERE LOWER(username) = LOWER(?)",
                              [String(b.username || "")]))[0];
    if (!u) return res.json({ ok: false, reply: "no account found" });
    const room = b.room ? String(b.room).slice(0, 64) : null;
    if (room) svc.noteRooms([{ id: room, name: b.room_name || room }]);
    let table = b.table && ID.test(String(b.table)) ? String(b.table) : null;
    if (!table && room) { await svc.boot(); const T = svc.tableForRoom(room); table = T ? T.id : null; }
    const actor = { uid: u.userId, name: String(b.name || u.displayname || u.username).replace(/[\u0000-\u001f]/g, " ").slice(0, 40),
                    username: u.username, camfrog: b.camfrog ? String(b.camfrog).slice(0, 40) : u.camfrogUsername || null, via: "room",
                    iph: null, admin: !!b.admin };
    const args = Array.isArray(b.args) ? b.args.slice(0, 2).map((x) => String(x).slice(0, 14)) : [];
    const out = await svc.act(actor, verb, args, { room, table }, `cf-${idem}`);
    res.json(out);
  });
}

module.exports = { register, WEB_VERBS, BOT_VERBS, _views: path.join(__dirname, "..", "views") };
