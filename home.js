// home.js — the homepage (/): what PATV is, live numbers from around the site, the live Camfrog
// room (bridge.js), the stream, quick links to every game, the top 5, and a personal strip for
// signed-in users. Site-wide numbers are cheap queries cached for STATS_TTL; only the personal strip
// is per request.
const { getQuery } = require("./dbUtils");
const bridge = require("./bridge");
const staking = require("./staking");
const cosmetics = require("./cosmetics");
const userstats = require("./userstats");

const STATS_TTL = 15 * 1000;
let statsCache = null, statsAt = 0, statsLoading = null;

const one = async (sql, params = []) => {
  try { return (await getQuery(sql, params))[0] || null; } catch (e) { console.error("[home]", e.message); return null; }
};

async function loadStats() {
  const out = {};
  const lotto = await one("SELECT data FROM lotto_state WHERE id = 1");
  if (lotto) {
    try {
      const L = JSON.parse(lotto.data);
      out.lotto = { jackpot: Number(L.jackpot) || 0, next_at: Number(L.next_at) || 0, open: !!L.sales_open, sold: Number(L.sold) || 0 };
    } catch (e) { out.lotto = null; }
  }
  const pot = await one("SELECT SUM(amount) AS pot FROM jackpot_rakes");
  out.casinoPot = (pot && Number(pot.pot)) || 0;
  try {
    const s = await staking.latest();
    if (s && s.nav) out.vaults = { house: Number(s.nav.house) || 0, bank: Number(s.nav.bank) || 0, mm: Number(s.nav.mm) || 0 };
  } catch (e) { out.vaults = null; }
  const m = await one("SELECT COUNT(*) AS n FROM markets WHERE status IN ('open','closed','settling')");
  out.markets = m ? m.n : 0;
  const b = await one("SELECT COUNT(*) AS n FROM bounties WHERE status = 'open'");
  out.bounties = b ? b.n : 0;
  const w = await one("SELECT COUNT(*) AS n FROM wagers WHERE status IN ('offered','accepting','active','settling','open','closed')");
  out.wagers = w ? w.n : 0;
  try {
    const T = require("./tables")._state().STATE;
    out.tables = T && Array.isArray(T.tables) ? T.tables.map((t) => (t.game === "bj" ? "Blackjack" : "Hold'em")) : [];
  } catch (e) { out.tables = []; }
  const u = await one("SELECT COUNT(*) AS n FROM users");
  out.members = u ? u.n : 0;
  try {
    out.top = await getQuery("SELECT username, displayname, avatar, points_balance, level FROM users ORDER BY points_balance DESC LIMIT 5");
  } catch (e) { out.top = []; }
  return out;
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
      const [S, rooms] = await Promise.all([stats(), bridge.summary(!!me)]);
      let gtf = null;
      if (me) {
        try { const av = userstats.avatarFor(await cosmetics.profileData(me.username)); gtf = av && av.svg ? av.svg : null; } catch (e) { gtf = null; }
      }
      res.locals.og = { title: "Public Access TV", description: "Live streams, Pepe the frog, Camfrog rooms live on the web, PAT games, markets and more.",
                        image: res.locals.ogBase + "/og/page.png?t=Public%20Access%20TV", url: res.locals.ogBase + "/" };
      res.render("home", {
        username: me ? me.username : null, me, gtf, S, rooms,
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
}

module.exports = { register, stats };
