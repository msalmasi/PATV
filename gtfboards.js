// gtfboards.js — 1.99wg: the Grand Theft Frogger leaderboards on the site (/gtf/leaderboards), retiring Pepe's Netlify
// heist board (pepe.publicaccess.tv/heist) - `!heisttop` / `!heistboard` / `!arenatop` / `!brawltop` / `!dueltop` link here.
//
// Data (computed here, cached BOARD_TTL_MS):
//   * GTF backend live (gtfstore.live())  -> the site's own records: gtf_records kind "sheet" + "pvp"
//   * otherwise                           -> the display mirror Pepe pushes (gtf_mirror, gtfsheet.js) - so the page works
//                                            before AND after the GTF cutover
// Numbers are read straight from Pepe's JSON text (gtfstore.topInts -> BigInt): loot can pass 2^53 on the staging sandbox.
//
// Boards (all-time only - a sheet keeps running totals with no per-event timestamps, so there is nothing to cut a week or a
// season from; a weekly board needs a per-heist / per-fight result log with times):
//   loot     total points stolen (sheet loot)
//   deep     deepest round reached (sheet deepest), then vault cracks, then loot
//   survive  success rate = (heists - busts) / heists, at least SURVIVE_MIN heists; then heists survived
//   arena    arena wins
//   brawl    wins - losses, then net, then wins (as Pepe's !brawltop)
//   duel     net points, then wins (as Pepe's !dueltop)
//
// Privacy (the analytics rules): a player shows as "someone" - no name, no link, no avatar - when
//   * Pepe reports them !incognito (incognito.js: incognito_state for linked logins, incognito_anon for every login), or
//   * their profile layout keeps the "Grand Theft Frogger" section off the public profile (hidden or "only me")
// Identity is the account (userId): a linked chat login shows its display name and links its profile; an unlinked one
// shows Pepe's display name for it and links its heist sheet.
"use strict";
const { getQuery } = require("./dbUtils");
const G = require("./gtfstore");

const BOARDS = ["loot", "deep", "survive", "arena", "brawl", "duel"];
const TOP = 25;
const SURVIVE_MIN = 10;
const BOARD_TTL_MS = 60e3;
const LOGIN_RE = /^[^\u0000-\u001f]{1,120}$/;
const NUMS = ["loot", "heists", "busts", "cracks", "deepest", "arena_wins", "brawl_wins", "brawl_losses", "brawl_net", "avatar_seed"];

let clock = () => Date.now();
const low = (s) => String(s == null ? "" : s).trim().replace(/^@+/, "").toLowerCase();
const cmp = (a, b) => (a > b ? -1 : a < b ? 1 : 0);          // BigInt / number, descending

let cache = null;      // {at, data}

/** The raw records: {mode, ts, sheets: Map login -> text, pvp: Map login -> text, display: Map login -> name} */
async function load() {
  await require("./gtfsheet").init();
  const sheets = new Map(), pvp = new Map(), display = new Map();
  let mode = null, ts = null;
  if (await G.live()) {
    mode = "site";
    for (const r of await getQuery("SELECT kind, id, data FROM gtf_records WHERE kind IN ('sheet', 'pvp') AND deleted = 0")) {
      (r.kind === "sheet" ? sheets : pvp).set(low(r.id), r.data);
    }
    // Pepe's mirror rows stay behind after the cutover: still the best display name for an unlinked login
    for (const r of await getQuery("SELECT id, display FROM gtf_mirror WHERE kind = 'sheet' AND display IS NOT NULL")) display.set(low(r.id), r.display);
  } else {
    const rows = await getQuery("SELECT kind, id, data, display FROM gtf_mirror WHERE kind IN ('sheet', 'pvp')");
    if (rows.length) {
      mode = "mirror";
      ts = (await G.meta("mirror_ts")) || null;
    }
    for (const r of rows) {
      (r.kind === "sheet" ? sheets : pvp).set(low(r.id), r.data);
      if (r.kind === "sheet" && r.display) display.set(low(r.id), r.display);
    }
  }
  return { mode, ts, sheets, pvp, display };
}

async function hasArchived() {
  try { return (await getQuery("PRAGMA table_info(users)")).some((c) => c.name === "archived_at"); } catch (e) { return false; }
}

/** login -> {userId, username, name} for the linked accounts among `logins` (live accounts only). */
async function accounts(logins) {
  const out = new Map();
  const list = [...logins];
  const arch = (await hasArchived()) ? " AND archived_at IS NULL" : "";
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    const rows = await getQuery(`SELECT userId, username, displayname, camfrogUsername FROM users
                                 WHERE lower(camfrogUsername) IN (${part.map(() => "?").join(",")})${arch}`, part).catch(() => []);
    for (const u of rows) {
      const k = low(u.camfrogUsername);
      if (!out.has(k)) out.set(k, { userId: u.userId, username: u.username, name: u.displayname || u.username || u.camfrogUsername });
    }
  }
  return out;
}

/** The logins shown as "someone": Pepe's incognito list (linked and not) + the accounts whose GTF section isn't public. */
async function privateSet(logins, accts) {
  const out = new Set();
  try {
    for (const r of await getQuery(`SELECT login FROM incognito_state WHERE "on" = 1`)) out.add(low(r.login));
  } catch (e) { /* no table yet: nobody reported */ }
  try {
    for (const r of await getQuery("SELECT login FROM incognito_anon")) out.add(low(r.login));
  } catch (e) { /* no table yet */ }
  const PL = require("./profilelayout");
  const byUser = new Map();
  for (const [login, a] of accts) if (logins.has(login)) byUser.set(String(a.userId), login);
  const ids = [...byUser.keys()];
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    let rows = [];
    try {
      rows = await getQuery(`SELECT user_id, layout FROM profile_layout WHERE user_id IN (${part.map(() => "?").join(",")})`, part);
    } catch (e) { rows = []; }
    for (const r of rows) {
      let st;
      try { st = PL.stateOf(PL.sanitize(JSON.parse(r.layout)), "gtf"); } catch (e) { st = "hidden"; }   // unreadable: fail closed
      if (st !== "public") out.add(byUser.get(String(r.user_id)));
    }
  }
  return out;
}

const big = (v) => (typeof v === "bigint" ? v : 0n);

/** Everything ranked (full lists, anonymised): {mode, ts, at, boards: {id: [row]}, counts} */
async function compute() {
  const { mode, ts, sheets, pvp, display } = await load();
  const logins = new Set([...sheets.keys(), ...pvp.keys()].filter((k) => k && LOGIN_RE.test(k)));
  const accts = await accounts(logins);
  const priv = await privateSet(logins, accts);

  const who = new Map();
  const person = (login, seed) => {
    if (who.has(login)) return who.get(login);
    const a = accts.get(login);
    const p = priv.has(login)
      ? { anon: true, login: null, name: null, href: null, seed: null }
      : { anon: false, login, name: (a && a.name) || display.get(login) || login,
          href: a && a.username ? "/u/" + encodeURIComponent(a.username) : "/gtf/sheet/" + encodeURIComponent(login),
          sheet: "/gtf/sheet/" + encodeURIComponent(login), seed: seed || null, userId: a ? String(a.userId) : null };
    who.set(login, p);
    return p;
  };

  const S = [];
  for (const [login, text] of sheets) {
    if (!logins.has(login) || typeof text !== "string") continue;
    let n;
    try { n = G.topInts(text, NUMS); } catch (e) { continue; }
    const seed = n.avatar_seed && n.avatar_seed > 0n && n.avatar_seed < 2n ** 31n ? Number(n.avatar_seed) : null;
    S.push({ login, n, seed });
  }
  const row = (s, f) => Object.assign({ ...person(s.login, s.seed) }, f);
  const rank = (list) => list.map((r, i) => Object.assign(r, { rank: i + 1 }));

  const loot = S.filter((s) => big(s.n.loot) > 0n)
    .sort((a, b) => cmp(big(a.n.loot), big(b.n.loot)) || a.login.localeCompare(b.login))
    .map((s) => row(s, { loot: String(big(s.n.loot)), heists: String(big(s.n.heists)) }));

  const deep = S.filter((s) => big(s.n.deepest) > 0n)
    .sort((a, b) => cmp(big(a.n.deepest), big(b.n.deepest)) || cmp(big(a.n.cracks), big(b.n.cracks)) || cmp(big(a.n.loot), big(b.n.loot)) || a.login.localeCompare(b.login))
    .map((s) => row(s, { deepest: Number(big(s.n.deepest)), cracks: String(big(s.n.cracks)) }));

  const survive = S.map((s) => {
    const h = big(s.n.heists), b = big(s.n.busts);
    const ok = h > b ? h - b : 0n;
    return { s, h, ok, rate: h > 0n ? Number((ok * 10000n) / h) / 100 : 0 };   // percent, 2 decimals, exact on BigInt
  }).filter((x) => x.h >= BigInt(SURVIVE_MIN))
    .sort((a, b) => cmp(a.rate, b.rate) || cmp(a.ok, b.ok) || a.s.login.localeCompare(b.s.login))
    .map((x) => row(x.s, { rate: x.rate, survived: String(x.ok), heists: String(x.h) }));

  const arena = S.filter((s) => big(s.n.arena_wins) > 0n)
    .sort((a, b) => cmp(big(a.n.arena_wins), big(b.n.arena_wins)) || a.login.localeCompare(b.login))
    .map((s) => row(s, { wins: String(big(s.n.arena_wins)) }));

  const brawl = S.filter((s) => big(s.n.brawl_wins) > 0n || big(s.n.brawl_losses) > 0n)
    .map((s) => ({ s, w: big(s.n.brawl_wins), l: big(s.n.brawl_losses), net: big(s.n.brawl_net) }))
    .sort((a, b) => cmp(a.w - a.l, b.w - b.l) || cmp(a.net, b.net) || cmp(a.w, b.w) || a.s.login.localeCompare(b.s.login))
    .map((x) => row(x.s, { w: String(x.w), l: String(x.l), net: String(x.net) }));

  const seedOf = new Map(S.map((s) => [s.login, s.seed]));
  const duel = [];
  for (const [login, text] of pvp) {
    if (!logins.has(login) || typeof text !== "string") continue;
    let n;
    try { n = G.topInts(text, ["wins", "losses", "net"]); } catch (e) { continue; }
    const w = big(n.wins), l = big(n.losses), net = big(n.net);
    if (w === 0n && l === 0n) continue;
    duel.push({ login, w, l, net });
  }
  duel.sort((a, b) => cmp(a.net, b.net) || cmp(a.w, b.w) || a.login.localeCompare(b.login));
  const duelRows = duel.map((d) => Object.assign({ ...person(d.login, seedOf.get(d.login)) }, { w: String(d.w), l: String(d.l), net: String(d.net) }));

  const boards = { loot: rank(loot), deep: rank(deep), survive: rank(survive), arena: rank(arena), brawl: rank(brawl), duel: rank(duelRows) };
  return { mode, ts, at: clock(), boards, counts: { players: S.length } };
}

async function data() {
  if (cache && clock() - cache.at < BOARD_TTL_MS) return cache.data;
  const d = await compute();
  cache = { at: clock(), data: d };
  return d;
}

/** What the page / API shows: the top TOP of each board + the viewer's own row (if they're further down and not anonymised).
 *  Internal fields (userId) stay here. viewer = the signed-in userId or null. */
async function view(viewer) {
  const d = await data();
  const me = viewer ? String(viewer) : null;
  const pub = (r) => (r.anon ? { rank: r.rank, anon: true, ...strip(r) } : { ...strip(r), mine: !!(me && r.userId === me) });
  const strip = (r) => { const o = { ...r }; delete o.userId; if (o.anon) { delete o.sheet; } return o; };
  const boards = {};
  for (const id of BOARDS) {
    const all = d.boards[id] || [];
    const top = all.slice(0, TOP).map(pub);
    const mineRow = me ? all.find((r) => r.userId === me && !r.anon) : null;
    boards[id] = { rows: top, total: all.length, me: mineRow && mineRow.rank > TOP ? pub(mineRow) : null };
  }
  return { mode: d.mode, ts: d.ts, at: d.at, boards, top: TOP, survive_min: SURVIVE_MIN, periods: ["all"] };
}

function register(app, { addUser }) {
  const uid = (req) => (req.user && req.user.userId) || null;
  app.get("/gtf/leaderboards", addUser, async (req, res) => {
    try {
      const v = await view(uid(req));
      const want = String(req.query.board || "");
      res.render("gtfboards", { user: req.user ? req.user.username : null, v, focus: BOARDS.includes(want) ? want : null });
    } catch (e) { console.error("[gtfboards] page:", e); res.status(500).send("Something went wrong."); }
  });
  app.get("/api/gtf/leaderboards", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json(Object.assign({ ok: true }, await view(uid(req)))); } catch (e) { console.error("[gtfboards] api:", e); res.status(500).json({ ok: false }); }
  });
}

module.exports = { register, compute, view, data, BOARDS, TOP, SURVIVE_MIN, BOARD_TTL_MS,
                   _reset: () => { cache = null; }, _setClock: (f) => { clock = f; cache = null; } };
