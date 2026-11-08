// casino/routes.js — the casino backend's HTTP API and pages (1.99lj blackjack, 1.99lv hold'em; docs/casino-backend.md).
//
// Web (a signed-in PATV account; no Camfrog link needed). Table routes work for both games ("bj" aliases kept):
//   GET  /casino/blackjack[/t/:id], /casino/holdem[/t/:id]    the pages (lobby + table)
//   GET  /api/casino/lobby                  open tables (both games), the rooms a table can be pushed to, the switches
//   GET  /api/casino/t/:id                  one table's public state + the viewer's own seat (Hold'em: ONLY their own hole
//                                            cards); per-user, never cached
//   POST /api/casino/open                   {game: bj|holdem, blinds?, theme?, idem}  open a web-only table (1.99amf h20: theme = a
//                                            casino/themes.js id; the lobby's `themes.pick` says whether this viewer may pick one)
//   POST /api/casino/t/:id/act              {verb, amount?, idem}
//   POST /api/casino/t/:id/push             {room|null, mode: add|remove}  attach / detach a Camfrog room Pepe serves (1.99ox: several at once; null = web only; host or admin)
//   POST /api/casino/t/:id/stream           {on, override?}  Pepe's stream: one table at a time, FIFO queue, admin override
//   GET  /casino/fair/:id/:round + /api/casino/fair/:id/:round    the fairness proof of a round / hand
//   GET  /api/casino/t/:id/history          (D10) a table's last revealed rounds: the felt's public summary + proof link
//   GET  /api/casino/t/:id/people           1.99ajw casino2: the seats for the person menu + the table's pads (signed in; casino/people.js)
//   GET  /api/casino/t/:id/pads             1.99ajw casino2: the table's pads alone (its 💬 Chat; anyone)
//   GET  /api/casino/t/:id/chatpads         tablechat: every pad chat the viewer may open from the table (?recent=, ?slug=; casino/chatpads.js)
//   (D10) GET /api/casino/t/:id also adds each seat's `avatar` and `watching` (web spectators); the lobby adds me.balance /
//   me.high_roller and each row's latest `proof`; app.locals.casinoOn(game) gates the navbar links on the site flags.
//   POST /api/casino/admin/settings         {key, value}  bj_enabled / hm_enabled / max_tables / bj_front / hm_front (site Admin, or the bot token)
//                                            h22: + casino_sng (off | staff | everyone) / sng_fee_pct / sng_buyins / sng_payouts / sng_levels /
//                                            sng_level_mins / sng_turbo_mins (validated: casino/tourney.js checkSetting)
// h22 (1.99alz) 🏁 Sit & Gos (casino/tourney.js; a sit & go's table is /casino/holdem/t/:id, its state GET /api/casino/t/:id -> table.tourney):
//   GET  /api/casino/sng                    the lobby block (also GET /api/casino/lobby -> sng): {on, can_create, sizes, buyins, fee_pct, payouts,
//                                            level_mins, turbo_mins, stack, countdown_secs, reg_mins, list: [rows]}
//   POST /api/casino/sng/new                {size, buyin, turbo, start_at, idem}  open one (the creator is registered)
//   POST /api/casino/sng/:id/register       {idem}   POST /api/casino/sng/:id/unregister {idem}  (a full refund before the start)
//   POST /api/casino/sng/:id/cancel         {idem, reason}  an admin with casino.admin: every entry refunded in full
// Pepe (bot token in the body):
//   POST /api/casino/bot/poll               {after, wait, rooms}  events of tables in rooms (cursor) + their public state
//                                            + `private` (room players' hole cards, by Camfrog name) + `stream`
//                                            1.99mw: in {ach_base: [{camfrog, m}], rep_ack: [key]}, out {rep: [{key, camfrog, amount}],
//                                            ach_want: [camfrog]} - the casino's gang rep for Pepe + his achievement counts (rewards.js)
//   POST /api/casino/bot/act                {room|table, username, camfrog, name, game?, verb, args, idem, channel, admin}
//                                            h22: game "sng" = !sng (verbs "" / list, new, join, leave, info, cancel, help; up to 5 args);
//                                            the poll adds `sng` (the open sit & gos) and each sit & go table's view has `tourney`;
//                                            review: + `sng_on` (the switch: off | staff | everyone; "off" while Hold'em is off)
// h22 phase 2 (1.99??) 🏆 SCHEDULED tournaments (casino/mtt.js; each one's tables are /casino/holdem/t/:id with table.tourney.kind "mtt"):
//   GET  /casino/holdem/mtt/:id             the tournament page (302 to /casino/holdem while the switch hides it from this viewer)
//   GET  /casino/holdem/leaderboard         the leaderboard page;  GET /admin/casino/mtt  the schedule manager (casino.admin)
//   GET  /api/casino/mtt                    the lobby block (also GET /api/casino/lobby -> mtt): {mtt_on, can_register, upcoming, registering, running, recent, mine}
//   GET  /api/casino/mtt/leaderboard        ?period=YYYY-MM|all&page=n (50 a page; veiled players never on it)
//   GET  /api/casino/mtt/:id                {mtt: the view, me, results}   /players?page= (masked rows)   /tables   /me
//   POST /api/casino/mtt/:id/register {idem, remind} (also late registration + re-entry) · /unregister {idem} · /remind {idem, on, telegram}
//   POST /api/casino/admin/mtt {id?, ...fields} create (repeat makes a series) / edit · /api/casino/admin/mtt/:id/<op> (cancel, void, pause,
//        resume, start, delay, max, stream, overlay-retry) · /api/casino/admin/mtt/:id/entry/:n/(refund|dq) · GET /api/casino/admin/mtt[/:id[/log]]
//   bot act game "mtt" (!mtt / !tourney; up to 2 args); a room player's bare Hold'em verb goes to the table where it's their turn first
//   (svc.tourneyTableFor); the poll reads `scene` {held} and answers `private_mtt` (cards / turn prompts / notice PMs) + `mtt_on`.
// Web POSTs are JSON with X-Requested-With: fetch (a cross-site form can't send them). Telegram never reaches here:
// gambling stays off the Telegram bridge (channel "telegram" is refused).
"use strict";
const path = require("path");
const { getQuery } = require("../dbUtils");
const svc = require("./service");
const rewards = require("./rewards");
const themes = require("./themes");       // 1.99amf h20: the table themes (the lobby's picker flag, the table page's theme files)

const WEB_VERBS = new Set(["bet", "autobet", "deal", "hit", "stand", "double", "split", "insurance", "leave", "end", "status", "fair",
                           "sit", "check", "call", "fold", "allin", "raise", "cards", "pre", "sitout", "sitin", "showhand"]);
const BOT_VERBS = new Set(["start", "bet", "autobet", "deal", "hit", "stand", "double", "split", "insurance", "leave", "end", "status",
                           "help", "open", "new", "go", "wager", "auto", "rebet", "close", "stop", "quit", "insure", "stay", "dd",
                           "table", "info", "show", "rules", "how", "fair", "",
                           "sit", "buyin", "buy", "join", "cashout", "next", "check", "call", "fold", "allin", "all-in", "raise", "cards",
                           "hand", "hole", "advertise", "advert", "ad", "unadvertise", "unadvert", "pre", "sitout", "sitin", "showhand",
                           "list", "cancel", "register", "unregister",       // (h22: + the !sng verbs, game "sng")
                           "reenter", "remind", "me", "top", "standings", "pause", "resume", "schedule"]);   // (h22 phase 2: + the !mtt verbs, game "mtt")
const ID = /^[0-9a-f]{10}$/;
const MID = /^m[0-9a-f]{9}$/;            // h22 phase 2: a scheduled tournament ("m" + 9 hex - never a table's 10 hex)
// h22 phase 2: the verbs a room player's bare command resolves turn-first for (never !sit / !holdem start: those are the room's table's)
const TURN_VERBS = new Set(["check", "call", "fold", "raise", "bet", "allin", "all-in", "pre", "cards", "hand", "hole", "sitout", "sitin", "showhand"]);
// (review) of those, the actions: quiet on success at an MTT table (the next turn PM is the feedback) - the rest (!cards, !sitout, !sitin,
// !pre, !showhand) answer with what the player asked for, as a PM
const QUIET_VERBS = new Set(["check", "call", "fold", "raise", "bet", "allin", "all-in"]);
const IDEM = /^[\w:.\-]{8,100}$/;
const HANDS_PER_MIN = 20;          // 1.99alq train3 verify: GET /api/casino/me/hands per account a minute

/** tablechat: the request's network for a network ban (netban.reqNet - the trusted proxy's address only; null = unknown) */
function netOf(req) { try { return require("../netban").reqNet(req); } catch (e) { return null; } }
function clientIp(req) {
  try { return require("../middleware/authGuard").clientIp(req); } catch (e) { return req.ip || null; }
}
const isJsonFetch = (req) => req.is("application/json") && req.get("X-Requested-With") === "fetch";

async function webActor(req) {
  if (!req.user || !req.user.userId) return null;
  const u = (await getQuery("SELECT userId, username, displayname, camfrogUsername, class FROM users WHERE userId = ?", [req.user.userId]))[0];
  if (!u) return null;
  return { uid: u.userId, name: u.displayname || u.username, username: u.username, camfrog: u.camfrogUsername || null, via: "web",
           iph: svc.ipHash(clientIp(req)), admin: require("../siteperms").can(u, "casino.admin") };
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
const tcache = new Map();            // h22 phase 2: table id -> {k: "<id>:<rev>", at, table} (MTT tables' public part, 1 s)
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
 *  the round's public summary; never the `players` column, which holds account ids - 1.99ajw casino2 rework: read here only so a
 *  player who is veiled now reads as their label / "someone", casino/veil.js maskRounds; it never leaves the server). */
async function history(tableId, limit) {
  await svc.ensure();
  const rows = await getQuery(`SELECT round_no, results, players, revealed FROM casino_rounds WHERE table_id = ? AND revealed IS NOT NULL
                               ORDER BY round_no DESC LIMIT ?`, [tableId, Math.max(1, Math.min(50, Math.trunc(Number(limit) || 20)))]);
  const parsed = rows.map((r) => {
    let res = null, players = [];
    try { res = r.results ? JSON.parse(r.results) : null; } catch (e) { res = null; }
    try { players = r.players ? JSON.parse(r.players) : []; } catch (e) { players = []; }
    return { r, results: res, players: Array.isArray(players) ? players : [] };
  });
  const masked = await require("./veil").maskRounds(tableId, parsed);
  return masked.map(({ r, results }) => ({ round: r.round_no, revealed: r.revealed, results, proof: `/casino/fair/${tableId}/${r.round_no}` }));
}

function register(app, { isBotToken, addUser, discordBridge }) {
  svc.setDiscordBridge(discordBridge);     // h22 phase 2: the tournament channel posts (index.js discordBridge)
  app.get("/api/casino/sizing.js", (req, res) => res.type("application/javascript").sendFile(path.join(__dirname, "sizing.js")));
  // 1.99alq train3 verify: every call scans the account's finished rounds - HANDS_PER_MIN a minute per account (the panel asks
  // when it opens; a script looping on it was unlimited database work)
  const handsHits = new Map();
  const handsOk = (uid, t = Date.now()) => {
    const a = (handsHits.get(uid) || []).filter((x) => t - x < 60e3);
    const ok = a.length < HANDS_PER_MIN;
    if (ok) a.push(t);
    handsHits.set(uid, a);
    if (handsHits.size > 20000) handsHits.clear();
    return ok;
  };
  app.get("/api/casino/me/hands", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ok:false,error:"Sign in to view your hands."});
    if (!handsOk(String(req.user.userId))) return res.status(429).json({ok:false,error:"Slow down - try again in a minute.",hands:[]});
    try { res.json({ok:true,hands:await svc.myHands(req.user.userId,req.query.limit)}); }
    catch (e) { console.error("[casino] my hands:",e); res.status(500).json({ok:false,hands:[]}); }
  });
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
    // 1.99ajw casino2 review F8: the tables carry the 💸 Tip modal and the person menu's moderation confirms now - never framed by another
    // site (nothing frames them; Pepe's OBS board is its own view; the table's 💬 Chat frame is the other way round)
    res.set({ "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'" });
    res.locals.og = { title: `${title} with Pepe — publicaccess.tv`,
                      description: game === "holdem" ? "No-Limit Hold'em on the web with your PAT — no Camfrog needed, or play the same table from a Camfrog room."
                                                     : "Pepe deals blackjack on the web: sit down with your PAT, no Camfrog needed — or play the same table from a Camfrog room.",
                      image: (res.locals.ogBase || "") + require("../og").pageUrl(title), url: (res.locals.ogBase || "") + (res.locals.ogPath || "") };
    res.render(game === "holdem" ? "casino-hm" : "casino-bj", { user: req.user ? req.user.username : null, signedIn: !!(req.user && req.user.userId),
                                                                tableId: id, title, bjOn: !!st.bj_enabled, hmOn: !!st.hm_enabled,
                                                                // 1.99amf h20: a themed table's page loads its CSS / art / sound (classic: none)
                                                                theme: T ? themes.themeOf(T, st) : "classic" });
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
    // 1.99ajw casino2 rework: a veiled host reads as their label (casino/veil.js - each open table's veils re-read first, at most every 2 s)
    for (const T of Array.from(svc.S.tables.values())) if (T.status === "open" && !svc.isMttTable(T)) await svc.refreshVeil(T);   // (h22 phase 2: not the MTT tables - a page each)
    // D10: each row also says its latest proof (a revealed round) and where it stands in the stream queue
    const tables = svc.lobby().map((row) => {
      const T = svc.getTable(row.id);
      const n = T ? T.last_revealed || T.last_hand_revealed || null : null;
      const qi = svc.S.stream.queue.indexOf(row.id);
      return Object.assign(row, { proof: n ? `/casino/fair/${row.id}/${n}` : null, stream_queue: qi >= 0 ? qi + 1 : null });
    });
    res.json({ enabled: st.bj_enabled, hm_enabled: st.hm_enabled, tables, rooms: svc.freshRooms(),
               stream: svc.S.stream.table, me, limits: svc.limits(), sng: await svc.TN.lobby(actor ? actor.uid : null),   // (h22: the Sit & Go block)
               themes: themes.lobbyInfo(actor ? { admin: actor.admin } : null, st),   // 1.99amf h20: may this viewer pick a theme
               mtt: await svc.MT.lobby(actor ? actor.uid : null) });                                                         // (h22 phase 2: the 🏆 block)
  };
  app.get(["/api/casino/lobby", "/api/casino/bj/lobby"], addUser, lobby);

  app.get(["/api/casino/t/:id", "/api/casino/bj/t/:id"], addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!ID.test(req.params.id)) return res.status(404).json({ ok: false, error: "No such table." });
    await svc.boot();
    const T = svc.getTable(req.params.id);
    if (!T) return res.status(404).json({ ok: false, error: "That table has closed." });
    await svc.refreshVeil(T);          // 1.99ajw casino2 rework: a veiled player is masked (casino/veil.js; at most every 2 s per table)
    // h22 phase 2: an MTT table's public part (the view + avatars) is cached per (table, rev) for a second - many players poll it
    const mtt = svc.isMttTable(T);
    const ck = mtt ? `${T.id}:${T.rev}` : null;
    let pub = ck && tcache.get(T.id);
    if (!(pub && pub.k === ck && Date.now() - pub.at < 1000)) {
      const table = svc.publicView(T);
      const keys = (T.eng && T.eng.seats) || [];
      const seats = table.seats || [];
      // D10: each seat's public avatar (both views list seats in T.eng.seats order) - (1.99ajw casino2 rework: never on a masked seat)
      for (let i = 0; i < seats.length && i < keys.length; i++) seats[i].avatar = seats[i].veil ? null : await avatarOf(keys[i]);
      pub = { k: ck, at: Date.now(), table };
      if (ck) { tcache.set(T.id, pub); if (tcache.size > 500) tcache.delete(tcache.keys().next().value); }
    }
    const out = { ok: true, now: Date.now(), table: pub.table, rooms: svc.freshRooms() };
    out.me = req.user && req.user.userId ? await svc.meView(T, req.user.userId) : null;     // only the viewer's own seat / cards
    if (mtt && req.user && req.user.userId) svc.MT.seen(req.user.userId);                    // (h22 phase 2: start presence)
    out.watching = noteViewer(T, req);
    res.json(out);
  });

  // 1.99ajw casino2: the seats as the person menu needs them + the table's pads (casino/people.js) - asked when the seats or the rooms
  // change and on a click with an old answer, never by the 1-2 s poll. Seats are for signed-in viewers; the pads (the 💬 Chat) for all.
  const people = require("./people");
  const chatpads = require("./chatpads");      // tablechat: the 💬 Chat's gate, picker and `more`
  app.get("/api/casino/t/:id/people", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (!ID.test(req.params.id)) return res.status(404).json({ ok: false, error: "No such table." });
    if (!people.rateOk("u:" + req.user.userId)) return res.status(429).json({ ok: false, error: "Slow down." });
    await svc.boot();
    const T = svc.getTable(req.params.id);
    if (!T) return res.status(404).json({ ok: false, error: "That table has closed." });
    try {
      await svc.refreshVeil(T);        // 1.99ajw casino2 rework: the same masks as the table view (casino/veil.js)
      const pads = await people.padsFor(T, req.user, netOf(req));
      const blk = await people.blocksOf(req.user);
      res.json({ ok: true, pepe: await people.pepeInfo(), pads, more: await chatpads.more(T, req.user, pads), seats: await people.seatsFor(T, req.user, pads), ...(blk ? { blk } : {}) });
    } catch (e) {
      console.error("[casino] people:", e);
      res.status(500).json({ ok: false, error: "Couldn't load the table's people." });
    }
  });
  app.get("/api/casino/t/:id/pads", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!ID.test(req.params.id)) return res.status(404).json({ ok: false, error: "No such table." });
    const key = req.user && req.user.userId ? "u:" + req.user.userId : "ip:" + (svc.ipHash(clientIp(req)) || "?");
    if (!people.rateOk("p" + key)) return res.status(429).json({ ok: false, error: "Slow down." });
    await svc.boot();
    const T = svc.getTable(req.params.id);
    if (!T) return res.status(404).json({ ok: false, error: "That table has closed." });
    try { const pads = await people.padsFor(T, req.user || null, netOf(req)); res.json({ ok: true, pads, more: await chatpads.more(T, req.user || null, pads) }); }
    catch (e) { console.error("[casino] pads:", e); res.status(500).json({ ok: false, pads: [] }); }
  });
  // tablechat (owner 2026-11-07: "let users pull up any pad chats regardless if its been advertised or added to a room chat"): the 💬 Chat's
  // picker - every pad chat this viewer may open (casino/chatpads.js: the table's own first, ?recent= slugs the page remembers, then the
  // rest), or one pad by its exact address (?slug=). Anyone (a guest: Public pads); private no-store; 40 a minute per account / address.
  // The frame itself is gated again by the chat embed (chatpads.gate) - nothing here is trusted by it.
  app.get("/api/casino/t/:id/chatpads", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!ID.test(req.params.id)) return res.status(404).json({ ok: false, error: "No such table." });
    const key = req.user && req.user.userId ? "u:" + req.user.userId : "ip:" + (svc.ipHash(clientIp(req)) || "?");
    if (!chatpads.rateOk(key)) return res.status(429).json({ ok: false, error: "Slow down." });
    await svc.boot();
    const T = svc.getTable(req.params.id);
    if (!T) return res.status(404).json({ ok: false, error: "That table has closed." });
    const q = req.query || {}, user = req.user && req.user.userId ? req.user : null;
    try {
      if (q.slug != null) return res.json({ ok: true, pad: await chatpads.one(T, user, String(q.slug), netOf(req)) });
      const recent = typeof q.recent === "string" ? q.recent.slice(0, 800).split(",") : [];
      res.json({ ok: true, pads: await chatpads.list(T, user, { net: netOf(req), recent }) });
    } catch (e) { console.error("[casino] chatpads:", e); res.status(500).json({ ok: false, pads: [] }); }
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
    const args = (game === "holdem" ? (b.blinds ? [String(b.blinds).slice(0, 24)] : []) : b.hr ? ["hr"] : [])
      .concat(b.theme ? [String(b.theme).slice(0, 24)] : []);          // 1.99amf h20: the picker's theme (the service checks it)
    const out = await svc.act(actor, "start", args, { room: null, game },
                              `web-${actor.uid}-${idem}`);
    res.status(out.ok ? 200 : 409).json(out);
  });

  // ── h22: 🏁 Sit & Gos (casino/tourney.js) - every move through svc.act (idempotent by the caller's key, under the casino's mutex) ──
  app.get("/api/casino/sng", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    await svc.boot();
    for (const T of Array.from(svc.S.tables.values())) if (T.tourney && T.status === "open" && !svc.isMttTable(T)) await svc.refreshVeil(T);
    res.json(Object.assign({ ok: true }, await svc.TN.lobby(req.user && req.user.userId ? String(req.user.userId) : null)));
  });
  app.post("/api/casino/sng/new", addUser, async (req, res) => {
    if (!isJsonFetch(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    const actor = await webActor(req);
    if (!actor) return res.status(401).json({ ok: false, error: "Sign in to play." });
    const b = req.body || {};
    const idem = String(b.idem || "");
    const size = Math.trunc(Number(b.size)), buyin = Math.trunc(Number(b.buyin));
    const at = b.start_at == null || b.start_at === "" ? null : Math.trunc(Number(b.start_at));
    if (!IDEM.test(idem) || !Number.isFinite(size) || !Number.isFinite(buyin) || (at !== null && !Number.isFinite(at))) return res.status(400).json({ ok: false, error: "Bad request." });
    const args = [String(size), String(buyin)].concat(b.turbo ? ["turbo"] : [], at ? ["at", String(at)] : []);
    const out = await svc.act(actor, "new", args, { game: "sng", room: null }, `web-${actor.uid}-${idem}`);
    res.status(out.ok ? 200 : 409).json(out);
  });
  for (const [seg, verb] of [["register", "join"], ["unregister", "leave"], ["cancel", "cancel"]]) {
    app.post(`/api/casino/sng/:id/${seg}`, addUser, async (req, res) => {
      if (!isJsonFetch(req)) return res.status(400).json({ ok: false, error: "Bad request." });
      const actor = await webActor(req);
      if (!actor) return res.status(401).json({ ok: false, error: "Sign in first." });
      const b = req.body || {};
      const idem = String(b.idem || "");
      if (!ID.test(req.params.id) || !IDEM.test(idem)) return res.status(400).json({ ok: false, error: "Bad request." });
      const args = [req.params.id].concat(verb === "cancel" && b.reason ? [String(b.reason).slice(0, 200)] : []);
      res.json(await svc.act(actor, verb, args, { game: "sng", room: null }, `web-${actor.uid}-${idem}`));
    });
  }

  // ── h22 phase 2: 🏆 scheduled tournaments (casino/mtt.js) - every money move through svc.act (idempotent, under the casino's mutex) ──
  const MT = svc.MT;
  const mttOf = async (id) => (MID.test(String(id || "")) ? svc.S.mtts.get(String(id)) || (await MT.loadOne(String(id))) : null);
  const uidOf = (req) => (req.user && req.user.userId ? String(req.user.userId) : null);
  const pagesRender = (view) => async (req, res) => {
    await svc.boot();
    const st = await svc.loadSettings();
    const id = req.params && req.params.id ? String(req.params.id) : null;
    if (id) {
      const M = await mttOf(id);
      if (!M || !(await MT.canSee(M, uidOf(req)))) return res.redirect("/casino/holdem");
      MT.seen(uidOf(req));
    } else if (!(await MT.canSee({ id: "-" }, uidOf(req))) && view === "board") return res.redirect("/casino/holdem");
    res.set({ "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'" });
    res.render("casino-mtt", { user: req.user ? req.user.username : null, signedIn: !!uidOf(req), mttId: id, view, title: view === "board" ? "Tournament leaderboard" : "Tournament",
                               hmOn: !!st.hm_enabled });
  };
  app.get("/casino/holdem/mtt/:id", addUser, pagesRender("mtt"));
  app.get("/casino/holdem/leaderboard", addUser, pagesRender("board"));
  app.get("/api/casino/mtt", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    await svc.boot();
    res.json(Object.assign({ ok: true, now: Date.now() }, await MT.lobby(uidOf(req))));
  });
  app.get("/api/casino/mtt/leaderboard", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    await svc.boot();
    const uid = uidOf(req);
    // (review) the switch hides it like its page (/casino/holdem/leaderboard): off / staff only = 403 for everyone else
    if (!(await MT.canSee({ id: "-" }, uid))) return res.status(403).json({ ok: false, error: "Tournaments aren't open yet.", code: "E_SWITCH" });
    const out = await MT.leaderboard(req.query.period, req.query.page);
    if (uid) out.my_veiled_points = await MT.veiledPoints(uid);
    res.json(Object.assign({ ok: true }, out));
  });
  const mttGet = (fn) => async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    await svc.boot();
    const M = await mttOf(req.params.id);
    if (!M) return res.status(404).json({ ok: false, error: "No such tournament.", code: "E_NO_MTT" });
    const uid = uidOf(req);
    if (!(await MT.canSee(M, uid))) return res.status(403).json({ ok: false, error: "Tournaments aren't open yet.", code: "E_SWITCH" });
    MT.seen(uid);
    try { res.json(Object.assign({ ok: true }, await fn(M, uid, req))); }
    catch (e) { console.error("[casino] mtt view:", e); res.status(500).json({ ok: false, error: "Couldn't load the tournament." }); }
  };
  app.get("/api/casino/mtt/:id", addUser, mttGet(async (M, uid) => ({ now: Date.now(), mtt: MT.publicView(M), me: uid ? await MT.meFor(M, uid) : null, results: await MT.results(M) })));
  app.get("/api/casino/mtt/:id/players", addUser, mttGet(async (M, uid, req) => MT.players(M, req.query.page)));
  app.get("/api/casino/mtt/:id/tables", addUser, mttGet(async (M) => ({ tables: MT.tablesView(M) })));
  app.get("/api/casino/mtt/:id/me", addUser, mttGet(async (M, uid) => {
    if (!uid) return { me: null };
    return { me: await MT.meFor(M, uid) };
  }));
  for (const [seg, verb] of [["register", "join"], ["unregister", "leave"], ["remind", "remind"]]) {
    app.post(`/api/casino/mtt/:id/${seg}`, addUser, async (req, res) => {
      if (!isJsonFetch(req)) return res.status(400).json({ ok: false, error: "Bad request." });
      const actor = await webActor(req);
      if (!actor) return res.status(401).json({ ok: false, error: "Sign in first." });
      const b = req.body || {};
      const idem = String(b.idem || "");
      if (!MID.test(req.params.id) || !IDEM.test(idem)) return res.status(400).json({ ok: false, error: "Bad request." });
      const M = await mttOf(req.params.id);
      if (!M) return res.status(404).json({ ok: false, error: "No such tournament.", code: "E_NO_MTT" });
      const args = [String(M.no)].concat(seg === "register" && b.remind ? ["remind"] : seg === "remind" ? [b.on === false ? "off" : "on"] : []);
      const out = await svc.act(actor, verb, args, { game: "mtt", room: null, telegram: seg === "remind" && b.telegram != null ? !!b.telegram : undefined }, `web-${actor.uid}-mtt-${seg}-${idem}`);
      const code = out.ok ? 200 : /aren't open yet/.test(out.reply || "") ? 403 : /Slow down/i.test(out.reply || "") ? 429 : 409;
      res.status(code).json(out);
    });
  }
  // admin (casino.admin; JSON fetch; every action audited in casino/mtt.js)
  const adminOk = async (req) => {
    if (!isJsonFetch(req) && req.method === "POST") return null;
    if (!req.user || !req.user.userId) return null;
    const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0];
    return u && require("../siteperms").can(u, "casino.admin") ? { uid: u.userId, name: u.username, userId: u.userId, username: u.username } : null;
  };
  app.get("/admin/casino/mtt", addUser, async (req, res) => {
    const a = await adminOk(req);
    if (!a) return res.redirect("/login");
    await svc.boot();
    res.render("admin/casino-mtt", { user: req.user ? req.user.username : null, title: "Tournaments" });
  });
  app.get("/api/casino/admin/mtt", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const a = await adminOk(req);
    if (!a) return res.status(403).json({ ok: false, error: "Casino admins only." });
    await svc.boot();
    const st = await svc.loadSettings();
    let onair = [];
    try { onair = (await require("../onairqueue").list()).map((b) => ({ at: b.at || null })); } catch (e) { onair = []; }   // (the on-air warning only)
    res.json({ ok: true, list: await MT.adminList(), gate: await MT.gateState(), settings: Object.fromEntries(Object.entries(st).filter(([k]) => k === "casino_mtt" || k.startsWith("mtt_"))),
               rooms: svc.freshRooms(), onair, now: Date.now() });
  });
  app.get("/api/casino/admin/mtt/:id", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const a = await adminOk(req);
    if (!a) return res.status(403).json({ ok: false, error: "Casino admins only." });
    const M = await mttOf(req.params.id);
    if (!M) return res.status(404).json({ ok: false, error: "No such tournament." });
    res.json({ ok: true, mtt: await MT.adminView(M) });
  });
  app.get("/api/casino/admin/mtt/:id/log", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const a = await adminOk(req);
    if (!a) return res.status(403).json({ ok: false, error: "Casino admins only." });
    const M = await mttOf(req.params.id);
    if (!M) return res.status(404).json({ ok: false, error: "No such tournament." });
    res.json({ ok: true, log: await MT.logOf(M) });
  });
  const adminPost = async (req, res, op, id, body) => {
    if (!isJsonFetch(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    const a = await adminOk(req);
    if (!a) return res.status(req.user && req.user.userId ? 403 : 401).json({ ok: false, error: "Casino admins only." });
    await svc.boot();
    const M = id ? await mttOf(id) : null;
    if (id && !M) return res.status(404).json({ ok: false, error: "No such tournament." });
    try {
      const r = await svc.locked(() => MT.admin(op, a, M, body));
      res.status(r && r.ok ? 200 : (r && r.status) || 409).json(Object.assign({ ok: false }, r));
    } catch (e) {
      res.status(e && e.status ? e.status : 500).json({ ok: false, error: e && e.status ? e.message : "Something went wrong." });
      if (!(e && e.status)) console.error("[casino] mtt admin:", e);
    }
  };
  app.post("/api/casino/admin/mtt", addUser, (req, res) => {
    const b = req.body || {};
    return adminPost(req, res, b.id ? "edit" : "create", b.id && MID.test(String(b.id)) ? String(b.id) : null, b);
  });
  app.post("/api/casino/admin/mtt/:id/entry/:n/:op", addUser, (req, res) => {
    const op = req.params.op === "refund" ? "refund" : req.params.op === "dq" ? "dq" : null;
    if (!op || !MID.test(req.params.id)) return res.status(404).json({ ok: false, error: "No such action." });
    return adminPost(req, res, op, req.params.id, Object.assign({}, req.body || {}, { n: Math.floor(Number(req.params.n)) }));
  });
  app.post("/api/casino/admin/mtt/:id/:op", addUser, (req, res) => {
    const ops = ["cancel", "void", "pause", "resume", "start", "delay", "max", "stream", "overlay-retry"];
    if (!ops.includes(req.params.op) || !MID.test(req.params.id)) return res.status(404).json({ ok: false, error: "No such action." });
    return adminPost(req, res, req.params.op, req.params.id, req.body || {});
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

  // 1.99pc: advertise a table in a Camfrog room (one announcement line + reminders; no gameplay there) - host or admin
  app.post("/api/casino/t/:id/advertise", addUser, async (req, res) => {
    if (!isJsonFetch(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    const actor = await webActor(req);
    if (!actor) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (!ID.test(req.params.id)) return res.status(404).json({ ok: false, error: "No such table." });
    const b = req.body || {};
    if (!b.room) return res.status(400).json({ ok: false, error: "Pick a room." });
    res.json(await svc.advertise(req.params.id, String(b.room).slice(0, 64), actor, b.on !== false));
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
      if (require("../siteperms").can(u, "casino.admin")) actor = u.username;
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
    svc.MT.noteScene(b.scene);                 // h22 phase 2: Pepe's on-air pick / IRL feed holds OBS (the final table's stream line)
    const wait = Math.max(0, Math.min(8, Number(b.wait) || 0)) * 1000;
    try {
      const st = await svc.loadSettings();
      // 1.99mw (casino/rewards.js): Pepe's achievement counts asked for last time + the gang-rep events he applied
      const tables = Array.from(svc.S.tables.values());
      if (Array.isArray(b.ach_base) && b.ach_base.length) await rewards.setBases(b.ach_base, tables);
      if (Array.isArray(b.rep_ack) && b.rep_ack.length) await rewards.repAck(b.rep_ack);
      const out = await svc.poll(b.after, wait);
      // (review) a Pepe that doesn't know tournaments (an older build: no `scene` in his poll) gets neither their lines (he'd post them
      // ungated by the room's poker toggle) nor a tournament table on his board (he'd draw it as a Sit & Go)
      if (!b.scene || typeof b.scene !== "object") {
        out.events = (out.events || []).filter((e) => e.kind !== "mtt");
        for (const [id, t] of Object.entries(out.tables || {})) if (t && t.tourney && t.tourney.kind === "mtt") delete out.tables[id];
      }
      out.rep = await rewards.repPending(50);
      out.ach_want = await rewards.wantBases(Array.from(svc.S.tables.values()));
      res.set("Cache-Control", "no-store");
      // 1.99pc: every open table (Pepe lists them as links in chat) + the lobby page each game's links use
      const base = svc.link({ id: "x", game: "bj" }).replace(/\/casino\/blackjack\/t\/x$/, "");
      out.open = svc.openList();
      out.lobby = { bj: base + svc.frontPath(st, "bj"), holdem: base + svc.frontPath(st, "holdem") };
      out.sng = svc.TN.openList();           // h22: the open sit & gos (each one's table in `tables` carries its `tourney` block)
      // h22 review: the Sit & Go switch as it stands for everyone (off | staff | everyone; "off" while Hold'em on the site is off) - Pepe's
      // answer in a room whose casino runs on his own tables (no pointer to a web lobby that shows no Sit & Go section)
      out.sng_on = st.hm_enabled ? st.casino_sng || "off" : "off";
      out.mtt_on = st.hm_enabled ? st.casino_mtt || "off" : "off";        // h22 phase 2: the scheduled tournaments' switch (private_mtt rides in `out`)
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
                              [String(b.username || "")]))[0]
      || (b.username ? await require("../usernames").findUser(b.username, { cols: "userId, username, displayname, camfrogUsername, class" }) : null);
    if (!u) return res.json({ ok: false, reply: "no account found" });
    const room = b.room ? String(b.room).slice(0, 64) : null;
    if (room) svc.noteRooms([{ id: room, name: b.room_name || room }]);
    let table = b.table && ID.test(String(b.table)) ? String(b.table) : null;
    const game = b.game === "holdem" ? "holdem" : b.game === "bj" ? "bj" : b.game === "sng" ? "sng" : b.game === "mtt" ? "mtt" : null;     // (h22: "sng" = !sng; phase 2: "mtt" = !mtt)
    // h22 phase 2: a bare Hold'em verb (!call, !fold, ...) from a room player goes to the table where it's their TURN first, then the room's
    // table if they sit there, then the only tournament table they sit at (svc.tourneyTableFor); seated at more than one: use the web
    let mttBare = false;
    if (!table && room && (game === "holdem" || game === null) && TURN_VERBS.has(verb)) {
      await svc.boot();
      const f = svc.tourneyTableFor(u.userId, room, { turnOnly: game === null });     // (a game-less !bet / !stand: only where it's their turn)
      if (f.err) return res.json({ ok: false, reply: f.err, pm: true });
      if (f.T) { table = f.T.id; mttBare = svc.isMttTable(f.T); }
    }
    if (!table && room && game !== "mtt") { await svc.boot(); const T = svc.tableForRoom(room); table = T ? T.id : null; }
    const actor = { uid: u.userId, name: String(b.name || u.displayname || u.username).replace(/[\u0000-\u001f]/g, " ").slice(0, 40),
                    username: u.username, camfrog: b.camfrog ? String(b.camfrog).slice(0, 40) : u.camfrogUsername || null, via: "room",
                    iph: null, admin: !!b.admin, room };
    // 1.99se: an advert's room name can be long / have spaces ("!bj advertise Drama Central") - Pepe sends it as one arg
    const argMax = ["advertise", "advert", "ad", "unadvertise", "unadvert"].includes(verb) ? 64 : 24;
    const args = Array.isArray(b.args) ? b.args.slice(0, game === "sng" ? 5 : 2).map((x) => String(x).slice(0, argMax)) : [];   // (h22: !sng new <seats> <buy-in> [turbo] [at N])
    const out = await svc.act(actor, verb, args, { room, table, game: mttBare ? "holdem" : game }, `cf-${idem}`);
    // (h22 phase 2) a bare verb at an MTT table: quiet on success (the next PM is the feedback), an error comes back as a PM
    if (mttBare) { if (out.ok && QUIET_VERBS.has(verb)) out.quiet = true; else out.pm = true; }
    res.json(out);
  });
}

module.exports = { register, WEB_VERBS, BOT_VERBS, _views: path.join(__dirname, "..", "views") };
