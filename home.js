// home.js — the homepage (/) and /about.
//
// The homepage is for using the site: the main stage (the stream when it's on air, the OBS wheel
// you can spin from here, the featured casino table), the live Camfrog room(s) with mic transcripts,
// your own strip (balance, level, lotto tickets, table seat, open bets, badges), what's live right
// now, and a compact "things to do". The explainer material lives on /about.
//
// Site-wide numbers are cheap queries cached for STATS_TTL; only the personal strip is per request.
const { getQuery } = require("./dbUtils");
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
  const mk = (await many("SELECT data FROM markets WHERE status = 'open'")).map((r) => parse(r.data)).filter(Boolean);
  out.markets = mk.length;
  out.closing = mk.filter((m) => m.id && m.question && m.closes > now).sort((a, b) => a.closes - b.closes).slice(0, 3)
    .map((m) => ({ id: m.id, q: String(m.question || "").slice(0, 120), closes: m.closes, pot: (m.bets || []).reduce((t, b) => t + (Number(b.amount) || 0), 0) }));
  out.betters = {};
  for (const m of mk) for (const b of m.bets || []) { const k = String(b.nick || "").toLowerCase(); if (k) out.betters[k] = (out.betters[k] || 0) + 1; }
  const bo = (await many("SELECT data FROM bounties WHERE status = 'open'")).map((r) => parse(r.data)).filter(Boolean);
  out.bounties = bo.length;
  out.topBounties = bo.filter((b) => b.id && b.task).map((b) => ({ id: b.id, task: String(b.task).slice(0, 120), pot: (b.pot || []).reduce((t, c) => t + (Number(c.amount) || 0), 0) }))
    .sort((a, b) => b.pot - a.pot).slice(0, 3);
  const w = await one("SELECT COUNT(*) AS n FROM wagers WHERE status IN ('offered','accepting','active','settling','open','closed')");
  out.wagers = w ? w.n : 0;
  const tables = tablesState();
  out.tables = tables.map((t) => ({ id: t.id, game: t.game === "bj" ? "Blackjack" : "Hold'em", featured: !!t.featured, phase: t.phase || "",
    room: t.room_name || t.room || "", seats: (t.seats || []).filter((x) => x && x.name).map((x) => String(x.name)) }));
  out.featured = out.tables.find((t) => t.featured) || out.tables[0] || null;
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

function register(app, { addUser, xpForNextLevel }) {
  app.get("/", addUser, async (req, res) => {
    try {
      const username = req.user ? req.user.username : null;
      let me = null;
      if (username) {
        me = (await getQuery(
          "SELECT username, displayname, class, level, xp, avatar, email, points_balance, camfrogUsername FROM users WHERE username = ?",
          [username]))[0] || null;
      }
      const [S, rooms, top] = await Promise.all([stats(), bridge.summary(!!me), topFrogs()]);
      // 1.99bi: the homepage features the FRONT ROOM (an admin's pick, else auto) - its stage (Pepe's
      // stream + that room's featured / live slots) and, when it's bridged, its live chat panel.
      // Pepe's !activeroom (his Camfrog window) no longer decides this.
      const reg = require("./rooms");
      const web = require("./roomsweb");
      const stage = bridge.stage();
      const front = await reg.frontRoom(rooms, bridge.stageRoomRef()).catch(() => ({ id: reg.HOUSE_ROOM, pinned: false }));
      const frontReg = await reg.get(front.id).catch(() => null);
      const frontInfo = frontReg ? { id: frontReg.id, slug: web.linkSlug(frontReg), title: frontReg.title, pinned: front.pinned,
                                     owner: frontReg.owner ? frontReg.owner.display || frontReg.owner.username : null } : null;
      const slots = await require("./mainstage").publicSlots(front.id).catch(() => []);
      const onStage = rooms.find((r) => r.id === front.id) || null;
      const room = onStage || rooms.find((r) => r.live) || rooms[0] || null;
      const isStaff = !!(me && (me.class === "Admin" || me.class === "Staff"));
      const stageAdmin = isStaff ? { front: reg.frontSetting(), rooms: (await reg.list()).map((r) => ({ id: r.id, title: r.title })) } : null;
      const mine = me ? await personal(me, S) : null;
      // the room widget renders with its first page of data (signed-in only), then polls
      const roomLive = me && room ? await bridge.liveFor(room.slug) : null;
      res.locals.og = { title: "Public Access TV", description: "Live streams, Pepe the frog, Camfrog rooms live on the web, PAT games, markets and more.",
                        image: res.locals.ogBase + "/og/page.png?t=Public%20Access%20TV", url: res.locals.ogBase + "/" };
      res.render("home", {
        username: me ? me.username : null, me, mine, S, rooms, room, roomLive, stage, top,
        roomOnStage: !!(onStage && room === onStage), stageAdmin, frontInfo, featuredPrice: require("./mainstage").config().price_per_min,
        // 1.99al: paid stage slots live now + whether this viewer can cut them
        slots, staff: isStaff || (await reg.canManage(req.user, front.id).catch(() => false)),
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

  app.get("/about", addUser, async (req, res) => {
    const S = await stats();
    const rooms = await bridge.summary(false);
    res.locals.og = { title: "About Public Access TV", description: "A community TV station, Camfrog rooms with Pepe the frog, live events, PAT games and more.",
                      image: res.locals.ogBase + "/og/page.png?t=About%20PATV", url: res.locals.ogBase + "/about" };
    res.render("about", { user: req.user ? req.user.username : null, S, room: rooms.find((r) => r.live) || rooms[0] || null });
  });
}

module.exports = { register, stats };
