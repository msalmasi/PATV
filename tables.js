// tables.js — Pepe's casino tables on PATV: /casino, /poker (Texas Hold'em), /blackjack.
//
// The tables themselves run in Pepe (the Camfrog bot): one Hold'em or Blackjack table at a time, in
// one Camfrog room. Pepe pushes the live state here on every change (/api/tables/sync, bot token,
// at most ~2 a second). The page polls /api/tables/state about once a second.
//
// Playing from the site: a signed-in user with a linked Camfrog name posts a seat action to
// /api/tables/act. It is queued as a pepe_actions row of kind "table" (actions.js), which Pepe
// claims on a fast lane (/api/tables/claim, every second while a table is open) and runs as that
// Camfrog name through the very same chat command — same rules, fees, timers and escrow — so web
// and Camfrog players sit at the same table. The result comes back through /api/actions/ack.
//
// TABLES ARE A COLLECTION: the sync body is a list of tables with ids; each has a HOME (where it's
// played: a Camfrog room today, "web" reserved for later) and a FEATURED flag (the table on the main
// stage: this site's main view and the stream overlay). Pepe caps how many can be open (max_tables,
// 1 for now). Every page action carries the id of the table it was aimed at, so a click on a table
// that has since closed can never land on a new one. /casino/t/<id> is a table's own page. Admins
// can feature/unfeature a table or push it to another Camfrog room (game "admin").
//
// PRIVACY: a Hold'em player's hole cards arrive in the sync body's `private` map, keyed by the PATV
// account that paid for the seat. That map is kept in memory only, apart from the public state, and
// /api/tables/state hands a signed-in user ONLY their own entry. It is never written to the
// database, never rendered into page HTML, and never included in anything another user can fetch.
const { runQuery, getQuery } = require("./dbUtils");
const actions = require("./actions");

const STALE_MS = 45 * 1000;           // no sync for this long = Pepe is offline / restarting
const EXPIRE_MS = 60 * 1000;          // a table action nobody claimed within this is dropped
const CARD = /^[2-9TJQKA][shdc]$/;
const VERBS = {
  holdem: { start: ["room", "blinds"], sit: ["int"], stand: [], deal: [], end: [], check: [], call: [],
            fold: [], allin: [], bet: ["int"], raise: ["int"] },
  bj: { start: ["room"], bet: ["int"], autobet: ["intoff"], deal: [], hit: [], stand: [], double: [],
        split: [], insurance: [], leave: [], end: [] },
  admin: { feature: [], unfeature: [], push: ["room"] },
};

let STATE = null;                      // the latest public state
let PRIV = new Map();                  // PATV username (lowercase) -> [that player's own seats, one per table]
let RECEIVED = 0;

// ── cleaning (the bot is trusted, but nothing malformed should reach a page) ──
const int = (v, lo = 0, hi = 1e12) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};
const str = (v, n = 80) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").slice(0, n);
const bool = (v) => !!v;
const cards = (a, n = 12) => (Array.isArray(a) ? a.slice(0, n).map(String).filter((c) => CARD.test(c)) : []);
const arr = (a, n) => (Array.isArray(a) ? a.slice(0, n).filter((x) => x && typeof x === "object") : []);

function siteTime(botTs, botNow, recv) {
  // the bot's clock -> ours: a deadline N seconds after the bot's "now" is N seconds after we got it
  const t = Number(botTs), b = Number(botNow);
  if (!Number.isFinite(t) || !Number.isFinite(b) || t <= 0) return null;
  return Math.round(recv + (t - b) * 1000);
}

function cleanMeta(t) {
  const h = t.home && typeof t.home === "object" ? t.home : {};
  return { home: { kind: h.kind === "web" ? "web" : "room", room: h.room ? str(h.room, 64) : null, room_name: str(h.room_name || h.room, 64) },
           featured: t.featured !== false };
}

function cleanHoldem(t, botNow, recv) {
  const turn = t.turn && typeof t.turn === "object" ? {
    seat: int(t.turn.seat, 0, 20), name: str(t.turn.name), to_call: int(t.turn.to_call), can_check: bool(t.turn.can_check),
    current_bet: int(t.turn.current_bet), min_to: int(t.turn.min_to), max_to: int(t.turn.max_to), paid: int(t.turn.paid),
    can_raise: bool(t.turn.can_raise), deadline: siteTime(t.turn.deadline, botNow, recv),
  } : null;
  const res = t.result && typeof t.result === "object" ? {
    hand_no: int(t.result.hand_no), uncontested: bool(t.result.uncontested), rake: int(t.result.rake),
    winners: arr(t.result.winners, 12).map((w) => ({ name: str(w.name), amount: int(w.amount), hand: str(w.hand), pot: str(w.pot, 20) })),
  } : null;
  return {
    id: str(t.id, 16), game: "holdem", room: str(t.room, 64), room_name: str(t.room_name, 64), phase: str(t.phase, 16),
    hand_no: int(t.hand_no), sb: int(t.sb), bb: int(t.bb), min_buy: int(t.min_buy), max_buy: int(t.max_buy),
    high_stakes: bool(t.high_stakes), host: str(t.host), board: cards(t.board, 5), pot: int(t.pot),
    pots: arr(t.pots, 10).map((p) => ({ amount: int(p.amount), players: int(p.players, 0, 20) })),
    current_bet: int(t.current_bet), max_seats: int(t.max_seats, 0, 20), act_secs: int(t.act_secs, 0, 600),
    rake_pct: Number(t.rake_pct) || 0, can_deal: bool(t.can_deal), next_at: siteTime(t.next_at, botNow, recv),
    turn, result: res, ...cleanMeta(t),
    seats: arr(t.seats, 12).map((s) => ({
      name: str(s.name), stack: int(s.stack), bet: int(s.bet), status: str(s.status, 12), cards_down: bool(s.cards_down),
      button: bool(s.button), blind: s.blind === "SB" || s.blind === "BB" ? s.blind : null, turn: bool(s.turn),
      leaving: bool(s.leaving), host: bool(s.host), shown: s.shown ? cards(s.shown, 2) : null,
      hand: s.hand ? str(s.hand) : null, winner: bool(s.winner),
    })),
  };
}

function cleanBj(t, botNow, recv) {
  const d = t.dealer && typeof t.dealer === "object" ? t.dealer : {};
  const turn = t.turn && typeof t.turn === "object" ? {
    seat: int(t.turn.seat, 0, 20), name: str(t.turn.name), hand_index: int(t.turn.hand_index, 0, 8),
    num_hands: int(t.turn.num_hands, 0, 8), can_double: bool(t.turn.can_double), can_split: bool(t.turn.can_split),
    deadline: siteTime(t.turn.deadline, botNow, recv),
  } : null;
  const res = t.result && typeof t.result === "object" ? {
    round_no: int(t.result.round_no),
    dealer: { value: int((t.result.dealer || {}).value), bust: bool((t.result.dealer || {}).bust), blackjack: bool((t.result.dealer || {}).blackjack) },
    players: arr(t.result.players, 12).map((p) => ({
      name: str(p.name), net: Math.round(Number(p.net) || 0),
      hands: arr(p.hands, 8).map((h) => ({ value: int(h.value), outcome: str(h.outcome, 12) })),
      insurance: p.insurance == null ? null : bool(p.insurance),
    })),
  } : null;
  const hidden = bool(d.hidden);
  return {
    id: str(t.id, 16), game: "bj", room: str(t.room, 64), room_name: str(t.room_name, 64), phase: str(t.phase, 16),
    round_no: int(t.round_no), min_bet: int(t.min_bet), max_bet: int(t.max_bet), host: str(t.host),
    max_seats: int(t.max_seats, 0, 20), act_secs: int(t.act_secs, 0, 600), decks: int(t.decks, 0, 12),
    // while Pepe's hole card is down only the upcard is kept, whatever arrives
    dealer: { cards: cards(d.cards, hidden ? 1 : 12), down: hidden ? int(d.down, 0, 1) : 0, value: int(d.value), hidden,
              bust: bool(d.bust), blackjack: bool(d.blackjack) },
    turn, result: res, ...cleanMeta(t),
    bet_deadline: siteTime(t.bet_deadline, botNow, recv), ins_deadline: siteTime(t.ins_deadline, botNow, recv),
    seats: arr(t.seats, 8).map((s) => ({
      name: str(s.name), bet: int(s.bet), pending: int(s.pending), insured: bool(s.insured), autobet: bool(s.autobet),
      turn: bool(s.turn), leaving: bool(s.leaving), host: bool(s.host),
      hands: arr(s.hands, 4).map((h) => ({
        cards: cards(h.cards, 12), value: int(h.value), soft: bool(h.soft), bet: int(h.bet), outcome: h.outcome ? str(h.outcome, 12) : null,
        is_bj: bool(h.is_bj), doubled: bool(h.doubled), current: bool(h.current),
      })),
    })),
  };
}

function cleanPrivate(p, tableIds) {
  const out = new Map();
  if (!p || typeof p !== "object") return out;
  for (const [u, list] of Object.entries(p).slice(0, 60)) {
    const seats = (Array.isArray(list) ? list : [list]).slice(0, 8)
      .filter((v) => v && typeof v === "object" && tableIds.has(String(v.table)))
      .map((v) => ({
        table: str(v.table, 16), game: v.game === "bj" ? "bj" : "holdem", seat: int(v.seat, 0, 20), name: str(v.name),
        cards: v.game === "bj" ? [] : cards(v.cards, 2), hand_no: int(v.hand_no), folded: bool(v.folded), leaving: bool(v.leaving),
        autobet: bool(v.autobet), lastbet: int(v.lastbet), pending: int(v.pending), insurance: int(v.insurance),
      }));
    if (seats.length) out.set(String(u).toLowerCase().slice(0, 80), seats);
  }
  return out;
}

function cleanSync(b) {
  const recv = Date.now();
  const botNow = Number(b.bot_now) || recv / 1000;
  const tables = arr(b.tables, 4).map((t) => (t.game === "bj" ? cleanBj(t, botNow, recv) : cleanHoldem(t, botNow, recv)));
  const cfg = b.config && typeof b.config === "object" ? b.config : {};
  const h = cfg.holdem || {}, j = cfg.bj || {};
  return {
    state: {
      tables, max_tables: int(b.max_tables || 1, 1, 50),
      rooms: arr(b.rooms, 30).map((r) => ({ id: str(r.id, 64), name: str(r.name, 64), holdem: bool(r.holdem), bj: bool(r.bj) })),
      busy: b.busy ? str(b.busy, 40) : null,
      log: arr(b.log, 40).map((l) => ({ ts: int(l.ts), game: l.game === "bj" ? "bj" : "holdem", text: str(l.text, 200) })),
      config: {
        holdem: { sb_cap: int(h.sb_cap), bb_cap: int(h.bb_cap), min_buy_bb: int(h.min_buy_bb), max_buy_bb: int(h.max_buy_bb),
                  act_secs: int(h.act_secs), max_seats: int(h.max_seats), next_hand_secs: int(h.next_hand_secs) },
        bj: { min_bet: int(j.min_bet), max_bet: int(j.max_bet), act_secs: int(j.act_secs), bet_secs: int(j.bet_secs),
              open_secs: int(j.open_secs), max_seats: int(j.max_seats), ins_secs: int(j.ins_secs) },
      },
    },
    priv: cleanPrivate(b.private, new Set(tables.map((t) => t.id))),
  };
}

// ── validation of a player's request (Pepe validates again) ──
function buildArgs(b, isAdmin) {
  const game = String(b.game || "");
  const verb = String(b.verb || "");
  const spec = (VERBS[game] || {})[verb];
  if (!spec) return { error: "That can't be done from the site." };
  if (game === "admin" && !isAdmin) return { error: "Only admins can change the main stage." };
  // the table this was aimed at (every action but "start" needs one that's still open)
  let table = null;
  if (verb !== "start") {
    const tables = (STATE && STATE.tables) || [];
    const want = String(b.table || "");
    table = want ? tables.find((t) => t.id === want) : null;
    if (!want && game !== "admin") {
      const same = tables.filter((t) => t.game === game);
      table = same.length === 1 ? same[0] : null;
    }
    if (!table) return { error: want ? "That table has closed." : "Which table? Reload the page." };
    if (game !== "admin" && table.game !== game) return { error: "That's a different game's table." };
  }
  const args = [game, verb];
  for (const kind of spec) {
    if (kind === "int" || kind === "intoff") {
      const raw = String(b.amount == null ? "" : b.amount).replace(/,/g, "").trim();
      if (kind === "intoff" && raw.toLowerCase() === "off") { args.push("off"); continue; }
      if (!/^\d{1,11}$/.test(raw) || Number(raw) <= 0) return { error: "Enter a whole number of PAT." };
      args.push(String(Number(raw)));
    } else if (kind === "room") {
      const room = String(b.room || "");
      const known = STATE && STATE.rooms.find((r) => r.id === room);
      if (!known) return { error: "Pick one of the rooms Pepe is in." };
      const g = game === "admin" ? table.game : game;
      if (!known[g]) return { error: `${g === "bj" ? "Blackjack" : "Hold'em"} is switched off in ${known.name}.` };
      args.push(room);
    } else if (kind === "blinds") {
      const m = /^\s*(\d{1,9})\s*\/\s*(\d{1,9})\s*$/.exec(String(b.blinds || ""));
      if (!m || Number(m[1]) < 1 || Number(m[2]) <= Number(m[1])) return { error: "Blinds look like 25/50 (small below big)." };
      args.push(`${Number(m[1])}/${Number(m[2])}`);
    }
  }
  if (table) args.push("t=" + table.id);
  const label = game === "admin" ? `!stage ${verb}${verb === "push" ? " " + args[2] : ""}` : (game === "bj" ? "!bj " : "!holdem ") + args.slice(1).filter((a) => !a.startsWith("t=")).join(" ");
  return { args, label };
}

function publicState() {
  const now = Date.now();
  if (!STATE) return { now, stale: true, updated: null, tables: [], rooms: [], busy: null, log: [], config: null };
  return Object.assign({ now, updated: RECEIVED, stale: now - RECEIVED > STALE_MS }, STATE);
}

function register(app, { isBotToken, addUser }) {
  app.post("/api/tables/sync", (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      const { state, priv } = cleanSync(b);
      STATE = state;
      PRIV = priv;           // replaced wholesale: a player who left loses their entry at once
      RECEIVED = Date.now();
      res.json({ ok: true });
    } catch (e) {
      console.error("[tables] sync:", e.message);
      res.status(400).json({ ok: false });
    }
  });

  // Pepe's fast lane: website table actions only. Old ones are dropped, not run late.
  app.post("/api/tables/claim", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
    try {
      const now = Date.now();
      await runQuery(`UPDATE pepe_actions SET status = 'failed', message = ?, updated = ?
                      WHERE kind = 'table' AND ((status = 'pending' AND created < ?) OR (status = 'claimed' AND claimed < ?))`,
        ["Pepe didn't get to it in time — nothing happened. Try again.", now, now - EXPIRE_MS, now - EXPIRE_MS]);
      const rows = await getQuery("SELECT * FROM pepe_actions WHERE kind = 'table' AND status = 'pending' ORDER BY id LIMIT 10");
      for (const a of rows) await runQuery("UPDATE pepe_actions SET status = 'claimed', claimed = ?, updated = ? WHERE id = ? AND status = 'pending'", [now, now, a.id]);
      res.json({ actions: rows.map((a) => {
        let args = [];
        try { args = JSON.parse(a.args); } catch (e) { args = []; }
        return { id: a.id, kind: "table", args, username: a.username, camfrog: a.camfrog, site_admin: !!a.site_admin };
      }) });
    } catch (e) {
      console.error("[tables] claim:", e.message);
      res.status(500).json({ actions: [] });
    }
  });

  // The live table + (for a signed-in player) their own seat and recent requests. Per-user: never cache.
  app.get("/api/tables/state", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const out = publicState();
    out.me = null;
    if (req.user && req.user.userId) {
      try {
        const u = (await getQuery("SELECT username, camfrogUsername, casino_banned, class FROM users WHERE userId = ?", [req.user.userId]))[0];
        if (u) {
          const acts = await actions.recentFor(req.user.userId, "casino", 6);
          out.me = {
            username: u.username, camfrog: u.camfrogUsername || null, banned: !!u.casino_banned, admin: u.class === "Admin",
            seats: PRIV.get(String(u.username).toLowerCase()) || [],            // ONLY this user's own seats
            actions: acts.map((a) => ({ id: a.id, label: a.label, status: a.status, message: a.message, created: a.created })),
          };
        }
      } catch (e) {
        console.error("[tables] state/me:", e.message);
      }
    }
    res.json(out);
  });

  // A seat action from the page. JSON only (a cross-site form can't send it), signed in, linked.
  app.post("/api/tables/act", addUser, async (req, res) => {
    if (!req.is("application/json") || req.get("X-Requested-With") !== "fetch") return res.status(400).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in to play." });
    const u = (await getQuery("SELECT camfrogUsername, casino_banned, class FROM users WHERE userId = ?", [req.user.userId]))[0];
    if (!u) return res.status(401).json({ ok: false, error: "Sign in to play." });
    const isAdmin = u.class === "Admin";
    const adminAct = String((req.body || {}).game) === "admin";
    if (!adminAct && !u.camfrogUsername) return res.status(403).json({ ok: false, error: "Link your Camfrog name first (type !verify in a Camfrog room) — you play as that name." });
    if (!adminAct && u.casino_banned) return res.status(403).json({ ok: false, error: "You're banned from the casino." });
    const built = buildArgs(req.body || {}, isAdmin);
    if (built.error) return res.status(400).json({ ok: false, error: built.error });
    if (!STATE || Date.now() - RECEIVED > STALE_MS) return res.status(503).json({ ok: false, error: "Pepe is offline right now — try again in a minute." });
    try {
      const id = await actions.queue(req.user.userId, { kind: "table", args: built.args, tag: "casino", label: built.label });
      res.json({ ok: true, id });
    } catch (e) {
      res.status(e.message === "busy" ? 429 : 500).json({ ok: false, error: e.message === "busy" ? "You already have a few moves waiting — give Pepe a second." : "Something went wrong — nothing was sent." });
    }
  });

  const page = (focus) => async (req, res) => {
    const tableId = req.params && req.params.id && /^[0-9a-f]{6,16}$/.test(req.params.id) ? req.params.id : null;
    if (req.params && req.params.id && !tableId) return res.redirect("/tables");
    try {
      let me = null;
      if (req.user && req.user.userId) {
        me = (await getQuery("SELECT username, camfrogUsername, points_balance, casino_banned FROM users WHERE userId = ?", [req.user.userId]))[0] || null;
      }
      let pokerNow = [];
      if (focus === "holdem") {
        try {
          pokerNow = await getQuery(`SELECT p.url, p.blinds, p.date_created, u.displayname, u.username FROM poker_now_games p
                                     JOIN users u ON p.userId = u.userId ORDER BY p.date_created DESC LIMIT 10`);
        } catch (e) { pokerNow = []; }
      }
      const titles = { holdem: "Texas Hold'em", bj: "Blackjack", lobby: "Casino tables" };
      res.locals.og = { title: `${titles[focus]} with Pepe — publicaccess.tv`,
                        description: "Play Pepe's No-Limit Hold'em and Blackjack tables from the web or from Camfrog chat — same table, same chips (PAT).",
                        image: res.locals.ogBase + "/og/page.png?t=" + encodeURIComponent(titles[focus]),
                        url: res.locals.ogBase + res.locals.ogPath };
      res.render("casino", { user: req.user ? req.user.username : null, me, focus, title: titles[focus], pokerNow, tableId });
    } catch (e) {
      console.error("[tables] page:", e);
      res.status(500).send("Something went wrong.");
    }
  };
  // the lobby: /tables (publicaccess.tv/casino exactly is redirected away at the CDN, so links use /tables)
  app.get(["/tables", "/casino"], addUser, page("lobby"));
  app.get("/casino/t/:id", addUser, page("lobby"));            // one table's own page
  app.get("/poker", addUser, page("holdem"));
  app.get(["/blackjack", "/bj"], addUser, page("bj"));
}

module.exports = { register, cleanSync, buildArgs, _state: () => ({ STATE, PRIV }) };
