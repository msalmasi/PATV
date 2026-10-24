// home.js — the homepage (/) and /about.
//
// The homepage is for using the site: the main stage (the stream when it's on air, the OBS wheel
// you can spin from here, the featured casino table), the live Camfrog room(s) with mic transcripts,
// your own strip (balance, level, lotto tickets, table seat, open bets, badges), what's live right
// now, and a compact "things to do". The explainer material lives on /about.
//
// Site-wide numbers are cheap queries cached for STATS_TTL; only the personal strip is per request.
const { getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const bridge = require("./bridge");
const staking = require("./staking");
const cosmetics = require("./cosmetics");
const userstats = require("./userstats");
const stale = require("./staleaccounts");

const STATS_TTL = 15 * 1000;
let statsCache = null, statsAt = 0, statsLoading = null;

const one = async (sql, params = []) => {
  try { return (await getQuery(sql, params))[0] || null; } catch (e) { console.error("[home]", e.message); return null; }
};
const many = async (sql, params = []) => {
  try { return await getQuery(sql, params); } catch (e) { console.error("[home]", e.message); return []; }
};
const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

function tablesState() {
  try {
    const T = require("./tables")._state().STATE;
    return T && Array.isArray(T.tables) ? T.tables : [];
  } catch (e) { return []; }
}

async function loadStats() {
  const out = {};
  const lotto = await one("SELECT data FROM lotto_state WHERE id = 1");
  const L = lotto ? parse(lotto.data) : null;
  out.lotto = L ? { jackpot: Number(L.jackpot) || 0, next_at: Number(L.next_at) || 0, open: !!L.sales_open, sold: Number(L.sold) || 0, price: Number(L.price) || 0 } : null;
  out.lottoPlayers = L && L.players && typeof L.players === "object" ? L.players : {};
  const pot = await one("SELECT SUM(amount) AS pot FROM jackpot_rakes");
  out.casinoPot = (pot && Number(pot.pot)) || 0;
  try {
    const s = await staking.latest();
    if (s && s.nav) out.vaults = { house: Number(s.nav.house) || 0, bank: Number(s.nav.bank) || 0, mm: Number(s.nav.mm) || 0 };
  } catch (e) { out.vaults = null; }
  // live markets: the soonest to close, plus who has bets in them (for "your open bets")
  const now = Date.now() / 1000;
  // 1.99ade: this cache is the same for every viewer (signed out included), so the "Now" box and its counts list only what a
  // signed-out visitor may see - a market / pool or a bounty on an Approved pad (og.anonHidden) is left out, as on /markets
  // and /bounties; so is a wager made in such a pad's room
  const og = require("./og");
  const mkRows = (await many("SELECT data, pad FROM markets WHERE status = 'open'")).map((r) => ({ r, d: parse(r.data) })).filter((x) => x.d);
  const mkAll = mkRows.map((x) => x.d);
  const mk = [];
  for (const x of mkRows) if (!(await og.anonHidden(await og.marketPad(x.r, x.d)))) mk.push(x.d);
  out.markets = mk.length;
  out.closing = mk.filter((m) => m.id && m.question && m.closes > now).sort((a, b) => a.closes - b.closes).slice(0, 3)
    .map((m) => ({ id: m.id, q: String(m.question || "").slice(0, 120), closes: m.closes, pot: (m.bets || []).reduce((t, b) => t + (Number(b.amount) || 0), 0) }));
  // "your open bets" (personal(): a member's own count) still counts every market they bet in
  out.betters = {};
  for (const m of mkAll) for (const b of m.bets || []) { const k = String(b.nick || "").toLowerCase(); if (k) out.betters[k] = (out.betters[k] || 0) + 1; }
  const bo = [];
  for (const b of (await many("SELECT data FROM bounties WHERE status = 'open'")).map((r) => parse(r.data)).filter(Boolean)) {
    if (!(await og.anonHidden(await og.bountyPad(b)))) bo.push(b);
  }
  out.bounties = bo.length;
  out.topBounties = bo.filter((b) => b.id && b.task).map((b) => ({ id: b.id, task: String(b.task).slice(0, 120), pot: (b.pot || []).reduce((t, c) => t + (Number(c.amount) || 0), 0) }))
    .sort((a, b) => b.pot - a.pot).slice(0, 3);
  let wn = 0;
  const padlinks = require("./padlinks");
  try { await padlinks.ready(); } catch (e) { /* the registry cache: rooms resolve to no pad */ }
  for (const r of await many("SELECT data FROM wagers WHERE status IN ('offered','accepting','active','settling','open','closed')")) {
    const w = parse(r.data);
    if (w && !(await og.anonHidden(padlinks.resolve({ pad: w.pad, room: w.room }) || null))) wn += 1;
  }
  out.wagers = wn;
  const tables = tablesState();
  out.tables = tables.map((t) => ({ id: t.id, game: t.game === "bj" ? "Blackjack" : "Hold'em", featured: !!t.featured, phase: t.phase || "",
    room: t.room_name || t.room || "", seats: (t.seats || []).filter((x) => x && x.name).map((x) => String(x.name)),
    href: "/casino/t/" + encodeURIComponent(t.id) }));
  // 1.99ol: a game whose casino FRONT END is the PATV casino (/admin/games) also lists the site casino's open tables,
  // linked to their /casino/<game>/t/<id> pages; the todo link goes to that front end's lobby
  out.tablesHref = "/tables";
  try {
    const csvc = require("./casino/service");
    const st = await csvc.loadSettings();
    out.tablesHref = csvc.frontPath(st, "lobby");
    for (const row of csvc.lobby()) {
      if (csvc.frontOf(st, row.game === "holdem" ? "holdem" : "bj") !== "patv") continue;
      const T = csvc.getTable(row.id);
      const v = T ? csvc.publicView(T) : null;
      out.tables.push({ id: row.id, game: row.game === "holdem" ? "Hold'em" : "Blackjack", featured: false, on_stream: !!row.on_stream,
        phase: (v && v.phase) || row.phase || "", room: row.room_name || "",
        seats: ((v && v.seats) || []).filter((x) => x && x.name).map((x) => String(x.name)),
        href: (row.game === "holdem" ? "/casino/holdem/t/" : "/casino/blackjack/t/") + encodeURIComponent(row.id) });
    }
  } catch (e) { console.error("[home] casino tables:", e.message); }
  out.featured = out.tables.find((t) => t.featured) || out.tables.find((t) => t.on_stream) || out.tables[0] || null;
  const u = await one(`SELECT COUNT(*) AS n FROM users WHERE ${stale.LIVE()}`);
  out.members = u ? u.n : 0;
  out.top = await many(`SELECT username, displayname, avatar, points_balance, level FROM users WHERE ${stale.LIVE()} ORDER BY points_balance DESC LIMIT 5`);
  return out;
}

// Top frogs (bottom of the homepage): the richest five with their GTF pixel avatars, like /rankings'
// podium. Rendering avatars costs a few queries each, so this has its own longer cache.
let topCache = null, topAt = 0;
async function topFrogs() {
  if (topCache && Date.now() - topAt < 60 * 1000) return topCache;
  const rows = await many(`SELECT username, displayname, avatar, points_balance, level FROM users WHERE ${stale.LIVE()} ORDER BY points_balance DESC LIMIT 5`);
  for (const r of rows) {
    try { const av = userstats.avatarFor(await cosmetics.profileData(r.username)); r.gtf = av && av.svg ? av.svg : null; } catch (e) { r.gtf = null; }
  }
  topCache = rows; topAt = Date.now();
  return rows;
}

function stats() {
  if (statsCache && Date.now() - statsAt < STATS_TTL) return Promise.resolve(statsCache);
  if (!statsLoading) {
    statsLoading = loadStats()
      .then((s) => { statsCache = s; statsAt = Date.now(); return s; })
      .catch((e) => { console.error("[home] stats:", e); return statsCache || {}; })
      .finally(() => { statsLoading = null; });
  }
  return statsLoading;
}

/** Things only this user needs: tickets, seat, bets, badges, pending website actions. */
async function personal(me, S) {
  const cf = me.camfrogUsername ? String(me.camfrogUsername).toLowerCase() : null;
  const out = { tickets: 0, seat: null, bets: 0, badges: 0, pending: 0, gtf: null };
  if (cf) {
    const p = S.lottoPlayers && S.lottoPlayers[cf];
    out.tickets = p ? Number(p.count) || 0 : 0;
    out.bets = (S.betters && S.betters[cf]) || 0;
    out.seat = (S.tables || []).find((t) => t.seats.some((n) => n.toLowerCase() === cf)) || null;
  }
  const b = await one("SELECT COUNT(*) AS n FROM user_badges WHERE userId = (SELECT userId FROM users WHERE username = ?)", [me.username]);
  out.badges = b ? b.n : 0;
  const a = await one("SELECT COUNT(*) AS n FROM pepe_actions WHERE username = ? AND status IN ('pending','claimed')", [me.username]);
  out.pending = a ? a.n : 0;
  try { const av = userstats.avatarFor(await cosmetics.profileData(me.username)); out.gtf = av && av.svg ? av.svg : null; } catch (e) { out.gtf = null; }
  return out;
}

/**
 * 1.99ek: the homepage's "Top Pads" (was "On now") - the top `n` LIVE pads in the front pick's order.
 * rows = bridge.summary() rows; ranked = rooms.rankLive().ranked (live only, best first, same score as the
 * front-page auto pick incl. boost points); boosts = Map id -> active boost PAT. A live row the ranking
 * missed (shouldn't happen) goes last by headcount. -> [{id, slug, name, count, micCount, boost}]
 */
/** 1.99kz: the pad is marked 18+ (registry cache; false when it isn't registered). */
function padAdult(id) {
  try { const p = require("./rooms").getCached(id); return !!(p && p.adult); } catch (e) { return false; }
}
function topPads(rows, ranked, boosts, n = 5) {
  const live = (rows || []).filter((r) => r && r.live && r.slug);
  const pos = new Map((ranked || []).map((r, i) => [r.id, i]));
  const at = (r) => (pos.has(r.id) ? pos.get(r.id) : Infinity);
  return live.slice().sort((a, b) => at(a) - at(b) || (b.count || 0) - (a.count || 0) || String(a.name).localeCompare(String(b.name)))
    .slice(0, n)
    .map((r) => ({ id: r.id, slug: r.slug, name: r.name, count: r.count || 0, micCount: r.micCount || 0, audio: !!r.audio,
                   boost: Math.round((boosts && boosts.get && boosts.get(r.id)) || 0), adult: padAdult(r.id) }));
}

/**
 * 1.99kp: "now playing" for the homepage's Top Pads - one short line per pad from state that's already cached:
 * the pad's live stage slot (mainstage.publicSlots(""): every room's live slots in one cached read) - its streamer
 * and title, a 📼 Plex title (library slots), an embed's title; else a Twitch-connected pad's live stream (golive.js,
 * memory); else who's on the mic (the bridge summary row's names - only filled where this viewer may see the room).
 * rows = the summary rows (with .mic names + .micCount) -> Map(id -> {k, name?, title?, names?, n?} | null)
 * stagefix site: viewer (null = signed out) - a 🎬 cam slot (someone's Camfrog cam) is "now playing" only for a signed-in viewer
 * who may see that pad's live room (padaccess.camSlotsFor); for anyone else the pad's next line shows (a stream, the mic).
 */
async function nowPlaying(rows, viewer) {
  const out = new Map();
  const ids = new Set((rows || []).map((r) => r && r.id).filter(Boolean));
  if (!ids.size) return out;
  let slots = [];
  try { slots = await require("./mainstage").publicSlots(""); } catch (e) { slots = []; }
  try { const PA = require("./padaccess"); await PA.init(); slots = PA.camSlotsFor(slots, viewer || null); } catch (e) { slots = slots.filter((s) => !(s && s.cam)); }
  const first = new Map();
  for (const s of slots) if (s && ids.has(s.room_id) && !first.has(s.room_id)) first.set(s.room_id, s);   // featured first, then earliest
  let twitchNow = () => null;
  try { twitchNow = require("./golive").twitchNow; } catch (e) { /* no go-live module */ }
  const cut = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
  for (const r of rows) {
    if (!r || !r.id) continue;
    const s = first.get(r.id);
    let np = null;
    if (s) {
      const title = cut(s.title, 80);
      if (/^📼/u.test(title)) np = { k: "plex", title: cut(title.replace(/^📼\s*/u, ""), 80), name: cut(s.display, 40) };
      else if (s.embed) np = { k: "embed", title: title || cut(require("./stageembed").label(s.embed), 60), name: cut(s.display, 40) };
      else np = { k: "stage", name: cut(s.display, 40), title };
    } else if (twitchNow(r.id)) {
      np = { k: "twitch", title: cut(twitchNow(r.id).title, 80) };
    } else if (Array.isArray(r.mic) && r.mic.length) {
      np = { k: "mic", names: r.mic.slice(0, 3).map((x) => cut(x, 30)), more: Math.max(0, (r.micCount || r.mic.length) - 3) };
    } else if (r.micCount) {
      np = { k: "mic_n", n: r.micCount };
    }
    // something is playing: still say who's on the mic (its own line under the title)
    if (np && np.k !== "mic" && np.k !== "mic_n") {
      if (Array.isArray(r.mic) && r.mic.length) np.mic = { k: "mic", names: r.mic.slice(0, 3).map((x) => cut(x, 30)), more: Math.max(0, (r.micCount || r.mic.length) - 3) };
      else if (r.micCount) np.mic = { k: "mic_n", n: r.micCount };
    }
    out.set(r.id, np);
  }
  return out;
}

/**
 * 1.99eo: the front pad's next SCHEDULED stage slot for the homepage's off-air slate ("Next up: ..."), or null.
 * Only what the stage would show anyway: the display name, the title, the start time - never ids or keys.
 * Requests still waiting for the owner's OK don't count.
 */
async function nextSlot(roomId, t = Date.now()) {
  const fut = await require("./mainstage").futureSlots(roomId);
  const s = (fut || []).find((x) => x && x.status === "scheduled" && (Number(x.start_at) || 0) >= t - 60 * 1000);
  return s ? { display: s.displayname || s.username || "someone", title: s.title || null, start_at: Number(s.start_at) } : null;
}

function register(app, { addUser, xpForNextLevel }) {
  app.get("/", addUser, async (req, res) => {
    try {
      const username = req.user ? req.user.username : null;
      let me = null;
      if (username) {
        me = (await getQuery(
          "SELECT userId, username, displayname, class, level, xp, avatar, email, points_balance, camfrogUsername FROM users WHERE username = ?",
          [username]))[0] || null;
        // 1.99xi: 🔥 the daily streak next to the level (streaks.js)
        if (me) me.streak = await require("./streaks").forUser(me.userId).catch(() => null);
      }
      // adultgate site: summary gets the viewer - an 18+ pad's mic names / topic follow the 18+ gate (off: no difference)
      const [S, allRooms, top] = await Promise.all([stats(), bridge.summary(!!me, req.user && req.user.userId ? req.user : null), topFrogs()]);
      // 1.99fu: pad visibility (padaccess.js) - an Approved pad this viewer is outside of isn't on their homepage at all
      // (not the featured room, not Top Pads, not the room widget, not a story circle); the front pick itself is
      // computed from every pad (one site-wide ranking, which never auto-picks an Approved pad - rooms.frontRoom)
      const PA = require("./padaccess");
      await PA.init();
      const viewer = req.user && req.user.userId ? req.user : null;
      const rooms = PA.visibleRows(viewer, allRooms);
      // 1.99bi: the homepage features the FRONT ROOM (an admin's pick, else auto) - its stage (Pepe's
      // stream + that room's featured / live slots) and, when it's bridged, its live chat panel.
      // Pepe's !activeroom (his Camfrog window) no longer decides this. 1.99cj: "auto" is a fair activity
      // ranking that holds its pick >= 30 min (rooms.js / frontroom.js), and Pepe's stream is part of the
      // featured room's stage whenever Pepe is IN that room (bridge.pepeIn), whatever his window shows.
      const reg = require("./rooms");
      const web = require("./roomsweb");
      const stage = bridge.stage();
      const front = await reg.frontRoom(allRooms, { viewer }).catch(() => ({ id: reg.HOUSE_ROOM, pinned: false }));
      const pepeHere = bridge.pepeIn(front.id) !== false;
      const frontReg = await reg.get(front.id).catch(() => null);
      // 1.99ek: Top Pads (the front pick's score, live pads only) + every pad's active boost PAT for the 🚀 badges
      // 1.99vm: every pad can be a Top Pad - pads without a connected Camfrog room rank on their site activity (padsignals.js)
      const pads = PA.visibleRows(viewer, await reg.withSitePads(allRooms).catch(() => allRooms));
      const RL = await reg.rankLive(pads).catch((e) => { console.error("[home] top pads:", e.message); return { ranked: [], boosts: new Map() }; });
      const tops = topPads(pads, RL.ranked, RL.boosts, 5);
      // 1.99hm: 🎧 listen from the homepage - may this viewer hear the pad (padaccess.full, same as /p/<slug>/audio)?
      // adultgate site: t.gate = the 18+ gate for this viewer ("ok" | "signin" | "confirm"; "ok" while the switch is off)
      for (const t of tops) { t.listen = PA.full(viewer, t.id); t.gate = PA.adultGate(viewer, t.id); }
      // 1.99kp: what's on in each Top Pad (refreshed by the page every 30 s: /api/home/nowplaying)
      const NP = await nowPlaying(pads.filter((r) => tops.some((t) => t.id === r.id)), viewer).catch(() => new Map());
      for (const t of tops) t.np = t.gate === "ok" ? NP.get(t.id) || null : null;     // adultgate site: no now-playing past the gate
      // adultgate site: ...nor its headcount / mic count (the ranking above used them like everyone else's)
      for (const t of tops) if (t.gate !== "ok") { t.count = null; t.micCount = null; }
      const frontInfo = frontReg ? { id: frontReg.id, slug: web.linkSlug(frontReg), title: frontReg.title, pinned: front.pinned,
                                     owner: frontReg.owner ? frontReg.owner.display || frontReg.owner.username : null,
                                     boost: Math.round(RL.boosts.get(frontReg.id) || 0) } : null;
      // adultgate site: + a cam slot's name blanked past the 18+ gate (padaccess.adultSlots)
      // stagefix site: + cam slots only for viewers who may see the pad's live room, mine: true on their own (mainstage.slotsFor)
      // stagefix fix: ...and never a cam slot here at all: a cam on a Stage plays only on its own pad page (D-21)
      const slots = (await require("./mainstage").slotsFor(front.id, viewer).catch(() => [])).filter((s) => !(s && s.cam));
      // 1.99eo: the off-air slate's "Next up" - the front pad's next scheduled slot (public facts only)
      const nextUp = await nextSlot(front.id).catch(() => null);
      const onStage = rooms.find((r) => r.id === front.id) || null;
      let room = onStage || rooms.find((r) => r.live) || rooms[0] || null;
      const isStaff = SP.can(me, "stage.admin");
      // 1.99xs: staff only get a link line now (the picker is on /pads/admin#front, Pepe's panel on /admin/pepe#control)
      const stageAdmin = isStaff ? { front: reg.frontSetting(), admin: SP.can(me, "pepe.control") } : null;
      const mine = me ? await personal(me, S) : null;
      // the room widget renders with its first page of data (signed-in only), then polls
      // 1.99fu: signed-out visitors too when the room's pad is Public (padaccess.full)
      // CL3: the viewer goes along - the pad's chat-history floors and each line's own access level apply (never exempt here)
      const roomLive = room && PA.full(viewer, room.id) ? await bridge.liveFor(room.slug, viewer) : null;
      // adultgate site: the widget's 18+ gate - "signin" / "confirm" swap the widget for the 18+ card (no lines, names or counts)
      const roomGate = room ? PA.adultGate(viewer, room.id) : "ok";
      if (room && roomGate !== "ok") room = { ...room, count: null, micCount: null };     // no headcount on the page either
      // S1 V2 (release L4): the panel's pad, a site pad at chat_backend = 'hub' while CHAT_HUB is on -> the chat hub's compact
      // <patv-chat> (chatwidget.forPad sets res.locals.chatWidget and reads padaccess's 18+ gate and the pad's level itself; null
      // otherwise). NOT REACHED IN S1: this panel shows the bridge's rooms, which are Camfrog rooms and never at 'hub' (S1 allows
      // the hub on site pads only) - it fires only if a hub site pad is put here, ADR 0007 D14's "Lounge chat" card lever (D17).
      if (room) await require("./chatwidget").forPad(req, res, { roomId: room.id, slug: room.slug, mode: "compact" });
      const roomOnStage_ = !!(onStage && room && room.id === onStage.id);
      // 1.99bz: the story strip (a circle per room with captures from the last 24 h); visitors get the circles only
      const storyRooms = await require("./stories").forViewer(req.user && req.user.userId ? req.user : null).catch((e) => { console.error("[home] stories:", e.message); return []; });
      // 1.99ci: "Hot on PATV" - the top 5 hot posts across every community (no NSFW for signed-out visitors)
      const hot = await require("./feedweb").hotMini(req.user && req.user.userId ? req.user : null).catch((e) => { console.error("[home] hot:", e.message); return null; });
      // 1.99kk: the banner slot (banner.js) - a paid booking for today, else a house promo (Pepeball with its live jackpot, ...)
      const banner = await require("./banner").pick({ lotto: S.lotto, lang: res.locals.lang || "en" }).catch((e) => { console.error("[home] banner:", e.message); return null; });
      res.locals.og = { title: "Public Access TV", description: "Pads with live stages, feeds and chat rooms, Pepe the frog, PAT games, markets and more.",
                        image: res.locals.ogBase + require("./og").pageUrl("Public Access TV"), url: res.locals.ogBase + "/" };
      res.render("home", {
        username: me ? me.username : null, me, mine, S, rooms, room, roomLive, roomGate, stage, top, tops, boostMark: require("./boostmark").boostMark,
        story: { rooms: storyRooms, caps: [], room: null, signed: !!me, compose: !!me }, hot, fx: require("./feedweb").fx, banner,
        roomOnStage: roomOnStage_, stageAdmin, frontInfo, pepeHere,
        // 1.99al: paid stage slots live now + whether this viewer can cut them
        slots, nextUp, staff: isStaff || (await reg.canManage(req.user, front.id).catch(() => false)),
        // kept for anything that still reads the old locals
        displayname: me ? me.displayname : null, classh: me ? me.class : null, level: me ? me.level : null,
        xp: me ? Math.round(me.xp) : null, avatar: me ? me.avatar : null, email: me ? me.email : null,
        points_balance: me ? me.points_balance : null, xpForNextLevel,
      });
    } catch (error) {
      console.error("[home]", error);
      res.status(500).send("Something went wrong.");
    }
  });

  // 1.99kp: the Top Pads' "now playing" lines - ?ids=<room id>,... (at most 8, only pads this viewer may see)
  app.get("/api/home/nowplaying", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const want = new Set(String(req.query.ids || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8));
      const PA = require("./padaccess");
      await PA.init();
      const viewer = req.user && req.user.userId ? req.user : null;
      const rows = PA.visibleRows(viewer, await bridge.summary(!!viewer, viewer)).filter((r) => want.has(r.id));
      const NP = await nowPlaying(rows, viewer);
      const np = {};
      for (const r of rows) np[r.id] = PA.adultGate(viewer, r.id) === "ok" ? NP.get(r.id) || null : null;     // adultgate site
      res.json({ ok: true, np });
    } catch (e) {
      console.error("[home] nowplaying:", e.message);
      res.status(500).json({ ok: false });
    }
  });

  app.get("/about", addUser, async (req, res) => {
    const S = await stats();
    const PA = require("./padaccess");
    await PA.init();
    const rooms = PA.visibleRows(req.user && req.user.userId ? req.user : null, await bridge.summary(false, req.user && req.user.userId ? req.user : null));    // 1.99fu; adultgate site: + the viewer
    res.locals.og = { title: "About Public Access TV", description: "A community TV station: pads with their own stages and chat rooms, Pepe the frog, live events, PAT games and more.",
                      image: res.locals.ogBase + require("./og").pageUrl("About PATV"), url: res.locals.ogBase + "/about" };
    res.render("about", { user: req.user ? req.user.username : null, S, room: rooms.find((r) => r.live) || rooms[0] || null });
  });
}

module.exports = { register, stats, topPads, nextSlot, nowPlaying };
