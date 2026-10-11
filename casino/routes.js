// casino/routes.js — the casino backend's HTTP API and pages (1.99lj blackjack, 1.99lv hold'em; docs/casino-backend.md).
//
// Web (a signed-in PATV account; no Camfrog link needed). Table routes work for both games ("bj" aliases kept):
//   GET  /casino/blackjack[/t/:id], /casino/holdem[/t/:id]    the pages (lobby + table)
//   GET  /api/casino/lobby                  open tables (both games), the rooms a table can be pushed to, the switches
//   GET  /api/casino/t/:id                  one table's public state + the viewer's own seat (Hold'em: ONLY their own hole
//                                            cards); per-user, never cached
//   POST /api/casino/open                   {game: bj|holdem, blinds?, idem}  open a web-only table
//   POST /api/casino/t/:id/act              {verb, amount?, idem}
//   POST /api/casino/t/:id/push             {room|null, mode: add|remove}  attach / detach a Camfrog room Pepe serves (1.99ox: several at once; null = web only; host or admin)
//   POST /api/casino/t/:id/stream           {on, override?}  Pepe's stream: one table at a time, FIFO queue, admin override
//   GET  /casino/fair/:id/:round + /api/casino/fair/:id/:round    the fairness proof of a round / hand
//   GET  /api/casino/t/:id/history          (D10) a table's last revealed rounds: the felt's public summary + proof link
//   (D10) GET /api/casino/t/:id also adds each seat's `avatar` and `watching` (web spectators); the lobby adds me.balance /
//   me.high_roller and each row's latest `proof`; app.locals.casinoOn(game) gates the navbar links on the site flags.
//   POST /api/casino/admin/settings         {key, value}  bj_enabled / hm_enabled / max_tables / bj_front / hm_front (site Admin, or the bot token)
// Pepe (bot token in the body):
//   POST /api/casino/bot/poll               {after, wait, rooms}  events of tables in rooms (cursor) + their public state
//                                            + `private` (room players' hole cards, by Camfrog name) + `stream`
//                                            1.99mw: in {ach_base: [{camfrog, m}], rep_ack: [key]}, out {rep: [{key, camfrog, amount}],
//                                            ach_want: [camfrog]} - the casino's gang rep for Pepe + his achievement counts (rewards.js)
//   POST /api/casino/bot/act                {room|table, username, camfrog, name, game?, verb, args, idem, channel, admin}
// Web POSTs are JSON with X-Requested-With: fetch (a cross-site form can't send them). Telegram never reaches here:
// gambling stays off the Telegram bridge (channel "telegram" is refused).
"use strict";
const path = require("path");
const { getQuery } = require("../dbUtils");
const svc = require("./service");
const rewards = require("./rewards");

const WEB_VERBS = new Set(["bet", "autobet", "deal", "hit", "stand", "double", "split", "insurance", "leave", "end", "status", "fair",
                           "sit", "check", "call", "fold", "allin", "raise", "cards"]);
const BOT_VERBS = new Set(["start", "bet", "autobet", "deal", "hit", "stand", "double", "split", "insurance", "leave", "end", "status",
                           "help", "open", "new", "go", "wager", "auto", "rebet", "close", "stop", "quit", "insure", "stay", "dd",
                           "table", "info", "show", "rules", "how", "fair", "",
                           "sit", "buyin", "buy", "join", "cashout", "next", "check", "call", "fold", "allin", "all-in", "raise", "cards",
                           "hand", "hole"]);
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

// ── read-only extras for the table pages (D10 design pass): seat avatars, a spectator count, hand history ──
// Avatars: users.avatar (the same public picture a profile shows), cached a minute per account.
const AV_TTL = 60 * 1000;
const avCache = new Map();          // uid -> {url, ts}
async function avatarOf(uid) {
  const hit = avCache.get(uid), t = svc.S.hooks.now();
  if (hit && t - hit.ts < AV_TTL) return hit.url;
  let url = null;
  try {
    const r = (await getQuery("SELECT avatar FROM users WHERE userId = ?", [uid]))[0];
    const a = r && r.avatar ? String(r.avatar) : "";
    url = /^(https:\/\/|\/)[^\s"'<>]{1,500}$/.test(a) && !a.startsWith("//") ? a : null;
  } catch (e) { url = null; }
  if (avCache.size > 5000) avCache.clear();
  avCache.set(uid, { url, ts: t });
  return url;
}
// Spectators: web viewers of a table page (signed-in account or a hashed address) seen polling in the last WATCH_MS,
// minus the ones seated. Memory only; nothing about a viewer leaves this map but the count.
const WATCH_MS = 10 * 1000;
const watchers = new Map();         // table id -> Map(viewer key -> ts)
function noteViewer(T, req) {
  const t = svc.S.hooks.now();
  const uid = req.user && req.user.userId ? String(req.user.userId) : null;
  const key = uid ? "u:" + uid : "ip:" + (svc.ipHash(clientIp(req)) || "?");
  let m = watchers.get(T.id);
  if (!m) { m = new Map(); watchers.set(T.id, m); }
  m.set(key, t);
  if (watchers.size > 500) for (const [id] of watchers) if (!svc.getTable(id)) watchers.delete(id);
  const seated = new Set((T.eng && T.eng.seats || []).map((k) => "u:" + k));
  let n = 0;
  for (const [k, ts] of m) {
    if (t - ts > WATCH_MS) { m.delete(k); continue; }
    if (!seated.has(k)) n += 1;
  }
  return n;
}
/** A table's last rounds from casino_rounds: only revealed ones, only what the felt already showed (results =
 *  the round's public summary; never the `players` column, which holds account ids). */
async function history(tableId, limit) {
  await svc.ensure();
  const rows = await getQuery(`SELECT round_no, results, revealed FROM casino_rounds WHERE table_id = ? AND revealed IS NOT NULL
                               ORDER BY round_no DESC LIMIT ?`, [tableId, Math.max(1, Math.min(50, Math.trunc(Number(limit) || 20)))]);
  return rows.map((r) => {
    let res = null;
    try { res = r.results ? JSON.parse(r.results) : null; } catch (e) { res = null; }
    return { round: r.round_no, revealed: r.revealed, results: res, proof: `/casino/fair/${tableId}/${r.round_no}` };
  });
}

function register(app, { isBotToken, addUser }) {
  const boot = () => svc.boot().catch((e) => console.error("[casino] boot:", e));
  setImmediate(boot);

  // 1.99ol: the FRONT END per game (casino_settings bj_front / hm_front, set on /admin/games; "auto" = follow the engine
  // flag, the pre-1.99ol behaviour). layout.ejs: casinoOn('bj' | 'holdem') = its links go to /casino/<game>;
  // casinoPath(game | 'lobby') = the page the site's links use (home.ejs, casino.ejs). A sync, cached read:
  // loadSettings() refreshes S.settings at most every 10 s, in the background; unknown = Pepe's tables.
  const cachedSettings = () => {
    if (svc.S.hooks.now() - svc.S.settingsAt > 10000) svc.loadSettings().catch(() => {});
    return svc.S.settings;
  };
  app.locals.casinoOn = (game) => svc.frontOf(cachedSettings(), game) === "patv";
  app.locals.casinoPath = (game) => svc.frontPath(cachedSettings(), game);

  // ── pages ──
  const page = (game) => async (req, res) => {
    const id = req.params && req.params.id ? String(req.params.id) : null;
    const home = game === "holdem" ? "/casino/holdem" : "/casino/blackjack";
    if (id && !ID.test(id)) return res.redirect(home);
    await svc.boot();
    const st = await svc.loadSettings();
    const T = id ? svc.getTable(id) : null;
    if (T && T.game !== game) return res.redirect(svc.link(T).replace(/^https?:\/\/[^/]+/, ""));
    // 1.99ol: the lobby follows the front-end setting (a table's own page always opens); an admin can still open it
    // with ?preview=1 to test it before switching
    if (!T && svc.frontOf(st, game) !== "patv" && !(req.query && req.query.preview && req.user && await svc.isSiteAdmin(req.user.userId))) {
      return res.redirect(svc.frontPath(st, game));
    }
    const title = game === "holdem" ? "Texas Hold'em" : "Blackjack";
    res.locals.og = { title: `${title} with Pepe — publicaccess.tv`,
                      description: game === "holdem" ? "No-Limit Hold'em on the web with your PAT — no Camfrog needed, or play the same table from a Camfrog room."
                                                     : "Pepe deals blackjack on the web: sit down with your PAT, no Camfrog needed — or play the same table from a Camfrog room.",
                      image: (res.locals.ogBase || "") + "/og/page.png?t=" + encodeURIComponent(title), url: (res.locals.ogBase || "") + (res.locals.ogPath || "") };
    res.render(game === "holdem" ? "casino-hm" : "casino-bj", { user: req.user ? req.user.username : null, signedIn: !!(req.user && req.user.userId),
                                                                tableId: id, title, bjOn: !!st.bj_enabled, hmOn: !!st.hm_enabled });
  };
  app.get("/casino/blackjack", addUser, page("bj"));
  app.get("/casino/blackjack/t/:id", addUser, page("bj"));
  app.get("/casino/holdem", addUser, page("holdem"));
  app.get("/casino/holdem/t/:id", addUser, page("holdem"));

  app.get("/casino/fair/:id/:round", addUser, async (req, res) => {
    res.render("casino-fair", { user: req.user ? req.user.username : null, title: "Casino fairness",
                                tableId: ID.test(req.params.id) ? req.params.id : "", round: Math.trunc(Number(req.params.round) || 0) });
  });

  // ── web API ──
  const lobby = async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    await svc.boot();
    const st = await svc.loadSettings();
    const actor = await webActor(req);
    let me = null;
    if (actor) {
      const u = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [actor.uid]))[0] || {};
      const hr = (await getQuery("SELECT 1 FROM user_roles WHERE userId = ? AND LOWER(role) = 'high roller'", [actor.uid]).catch(() => []))[0];
      me = { name: actor.name, admin: actor.admin, balance: Number(u.points_balance) || 0, high_roller: !!hr };
    }
    // D10: each row also says its latest proof (a revealed round) and where it stands in the stream queue
    const tables = svc.lobby().map((row) => {
      const T = svc.getTable(row.id);
      const n = T ? T.last_revealed || T.last_hand_revealed || null : null;
      const qi = svc.S.stream.queue.indexOf(row.id);
      return Object.assign(row, { proof: n ? `/casino/fair/${row.id}/${n}` : null, stream_queue: qi >= 0 ? qi + 1 : null });
    });
    res.json({ enabled: st.bj_enabled, hm_enabled: st.hm_enabled, tables, rooms: svc.freshRooms(),
               stream: svc.S.stream.table, me, limits: svc.limits() });
  };
  app.get(["/api/casino/lobby", "/api/casino/bj/lobby"], addUser, lobby);

  app.get(["/api/casino/t/:id", "/api/casino/bj/t/:id"], addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!ID.test(req.params.id)) return res.status(404).json({ ok: false, error: "No such table." });
    await svc.boot();
    const T = svc.getTable(req.params.id);
    if (!T) return res.status(404).json({ ok: false, error: "That table has closed." });
    const out = { ok: true, now: Date.now(), table: svc.publicView(T), rooms: svc.freshRooms() };
    out.me = req.user && req.user.userId ? await svc.meView(T, req.user.userId) : null;     // only the viewer's own seat / cards
    // D10: each seat's public avatar (both views list seats in T.eng.seats order) and how many web viewers are watching
    const keys = (T.eng && T.eng.seats) || [];
    const seats = out.table.seats || [];
    for (let i = 0; i < seats.length && i < keys.length; i++) seats[i].avatar = await avatarOf(keys[i]);
    out.watching = noteViewer(T, req);
    res.json(out);
  });

  app.get("/api/casino/t/:id/history", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!ID.test(req.params.id)) return res.status(404).json({ ok: false, error: "No such table." });
    try {
      res.json({ ok: true, rounds: await history(req.params.id, req.query.limit) });
    } catch (e) {
      console.error("[casino] history:", e);
      res.status(500).json({ ok: false, rounds: [] });
    }
  });

  app.post(["/api/casino/open", "/api/casino/bj/open"], addUser, async (req, res) => {
    if (!isJsonFetch(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    const actor = await webActor(req);
    if (!actor) return res.status(401).json({ ok: false, error: "Sign in to play." });
    const b = req.body || {};
    const idem = String(b.idem || "");
    if (!IDEM.test(idem)) return res.status(400).json({ ok: false, error: "Bad request." });
    const game = b.game === "holdem" ? "holdem" : "bj";
    // 1.99ov: b.hr = a 💎 High Roller blackjack table (Hold'em: the ladder's blinds say it)
    const args = game === "holdem" ? (b.blinds ? [String(b.blinds).slice(0, 24)] : []) : b.hr ? ["hr"] : [];
    const out = await svc.act(actor, "start", args, { room: null, game },
                              `web-${actor.uid}-${idem}`);
    res.status(out.ok ? 200 : 409).json(out);
  });

  app.post(["/api/casino/t/:id/act", "/api/casino/bj/t/:id/act"], addUser, async (req, res) => {
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

  app.post(["/api/casino/t/:id/push", "/api/casino/bj/t/:id/push"], addUser, async (req, res) => {
    if (!isJsonFetch(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    const actor = await webActor(req);
    if (!actor) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (!ID.test(req.params.id)) return res.status(404).json({ ok: false, error: "No such table." });
    const room = (req.body || {}).room ? String(req.body.room).slice(0, 64) : null;
    const mode = (req.body || {}).mode === "remove" ? "remove" : "add";       // 1.99ox: attach / detach one room
    res.json(await svc.push(req.params.id, room, actor, mode));
  });

  app.post("/api/casino/t/:id/stream", addUser, async (req, res) => {
    if (!isJsonFetch(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    const actor = await webActor(req);
    if (!actor) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (!ID.test(req.params.id)) return res.status(404).json({ ok: false, error: "No such table." });
    const b = req.body || {};
    res.json(await svc.stream(req.params.id, b.on !== false, actor, !!b.override));
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
      // 1.99mw (casino/rewards.js): Pepe's achievement counts asked for last time + the gang-rep events he applied
      const tables = Array.from(svc.S.tables.values());
      if (Array.isArray(b.ach_base) && b.ach_base.length) await rewards.setBases(b.ach_base, tables);
      if (Array.isArray(b.rep_ack) && b.rep_ack.length) await rewards.repAck(b.rep_ack);
      const out = await svc.poll(b.after, wait);
      out.rep = await rewards.repPending(50);
      out.ach_want = await rewards.wantBases(Array.from(svc.S.tables.values()));
      res.set("Cache-Control", "no-store");
      res.json(Object.assign({ ok: true, enabled: st.bj_enabled, hm_enabled: st.hm_enabled }, out));
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
    const game = b.game === "holdem" ? "holdem" : b.game === "bj" ? "bj" : null;
    const actor = { uid: u.userId, name: String(b.name || u.displayname || u.username).replace(/[\u0000-\u001f]/g, " ").slice(0, 40),
                    username: u.username, camfrog: b.camfrog ? String(b.camfrog).slice(0, 40) : u.camfrogUsername || null, via: "room",
                    iph: null, admin: !!b.admin, room };
    const args = Array.isArray(b.args) ? b.args.slice(0, 2).map((x) => String(x).slice(0, 24)) : [];
    const out = await svc.act(actor, verb, args, { room, table, game }, `cf-${idem}`);
    res.json(out);
  });
}

module.exports = { register, WEB_VERBS, BOT_VERBS, _views: path.join(__dirname, "..", "views") };
