// gangs.js — G1 of the backend migration: the gang system lives on the site; Pepe is a client.
//
// Until now every gang lived in ONE bot file (Pepe's gang_data.json): the registry, members and ranks, the per-rank daily
// withdrawal allowances, upgrades, heat, war records, the treasuries and rep. Treasury money moved in two steps across two
// stores (a wallet charge, then a JSON add; a JSON subtract, then a wallet credit), so a crash in between lost or doubled
// PAT. After the cutover (docs/gangs-cutover-runbook.md) the site owns all of it:
//
//   gangs            gid PK (Pepe's ids carried over), name, tag (both unique, case-insensitive), boss (member key), rep,
//                    heat, wars_w / wars_l, unpaid_days, upgrades / rank_limits / withdrawn (JSON), withdraw_date, created,
//                    extra (JSON: the engine fields Pepe keeps on a gang - last_claim, last_invade, turf_rep0, ...)
//   gang_members     member_key PK (Pepe's identity key: the canonical Camfrog login, lower case; "u:<userId>" for a
//                    web-only account), gid, rank (owner | officer | member | recruit), userId (the PATV account: a linked
//                    one, else the automatic "CF..." account Pepe made for that Camfrog name), seq (roster order), joined
//   gang_invites     member_key PK -> gid (one pending invite per person, like Pepe's), inviter_key, created
//   gang_ops         key PK (the caller's idempotency key), gid, op, actor_key, via, ts, result (JSON): every op once
//   gang_rep_events  key PK (the win), gid, member_key, userId, amount, src, ts - rep is applied once per key
//   gangs_disbanded  gid PK, data (JSON: Pepe's gangs["disbanded"][gid] record: members, payouts, released boroughs, ...)
//   gangs_meta       enabled / live / imported / rev / cfg / rollbacks
//   TREASURIES       a row per gang in the pools table, key "gang:<gid>" (pools.js keeps them out of every pool view).
//                    Every treasury change is ONE keyed move (pool_moves / pool_move_legs) in the SAME transaction as the
//                    wallet row, the protocol-pool legs (Fort Knox, the Reserve, ...) and the gang row it goes with.
//
// What stays in Pepe: the game engines (heists, invasions, claims, the turf map, the daily turf tick) and every chat
// announcement. They post keyed moves here: a treasury credit from turf money Pepe holds (tills, stakes, buy-ins) is a
// one-leg move, a debit to it the same; a tick's income / interest / upkeep / raid tax is one multi-leg move per gang.
// Turf state (boroughs, room control) is NOT here - see docs/room-turf-map.md.
//
// Rep: Pepe posts the rep of every Camfrog win (batched, keyed); the site's own wins (the casino, the lotto) apply it here
// directly - casino_rep_queue and Pepe's lotto rep path retire once the gangs are live.
//
// The switch (like the pools): gangs_meta.enabled (default on on staging, off on prod) lets Pepe hand the gangs over;
// "live" is set by the import. Requires the pools to be live here first (treasury legs touch Fort Knox / the Reserve).
//
// Bot routes (bot token, POST - the staging router falls back to Pepe's sandbox): /api/gangs/bot/state, /op, /rep,
// /move-status, /config; /api/gangs/admin/import, /export, /rollback. Web: /gtf/gangs, /gtf/gangs/:tag, /api/gangs,
// /api/gangs/:tag, POST /api/gangs/act (deposit / withdraw / invite / accept / decline / leave / kick / promote / demote /
// limits). Admin: GET /api/admin/gangs, POST /api/admin/gangs-backend {on}.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const KEY_RE = /^[A-Za-z0-9_.:@\-]{6,160}$/;
const GID_RE = /^[A-Za-z0-9]{2,32}$/;
const MKEY_RE = /^[^\s\u0000-\u001f"<>]{1,80}$/;
const RANKS = ["owner", "officer", "member", "recruit"];
const VAULT_DESTS = new Set(["reserve", "heist", "fortknox", "mm", "bank", "stakers", "jackpot"]);   // pepe_turfseason cut dests
const KNOWN = new Set(["name", "tag", "boss", "officers", "members", "recruits", "treasury", "rep", "heat", "wars", "upgrades",
                       "rank_limits", "unpaid_days", "withdraw_date", "withdrawn", "created"]);
const NO_EXTRA = new Set(["wd_pending", "turf_marks"]);         // Pepe-local journals that never travel
const MAX_LEGS = 24;
const POOL_PREFIX = "gang:";

// Pepe's constants (frida-bot.py GANG_* / TURF_GANG_UPGRADES / TURF_LAUNDER_CUT ...). He pushes his own at the cutover and
// at every start (/api/gangs/bot/config); these are the same values, for a site that never heard from him.
const DEFAULT_CFG = {
  cut_rate: 0.05, rank_limits: { owner: 0, officer: 250000, member: 100000, recruit: 25000 }, rep_per_level: 5000,
  base_members: 8, members_per_level: 2, recruiter_per: 2, tag_min: 2, tag_max: 5, name_min: 3, name_max: 24, defect_days: 2,
  upgrades: {
    recruiter: { name: "Recruiter", cost: 40000, max: 3, desc: "+2 member-cap slots per level" },
    warchest: { name: "War Chest", cost: 60000, max: 3, desc: "+1% daily treasury interest per level" },
    armory: { name: "Armory", cost: 50000, max: 3, desc: "+1 to your raid crews' rolls per level" },
    lookouts: { name: "Lookouts", cost: 45000, max: 3, desc: "+1 defence capacity per level (more defenders count toward the wall)" },
    bribes: { name: "Bribed Officials", cost: 55000, max: 3, desc: "less heat, smaller raids" },
  },
  cut_shares: [["fortknox", 100]], tz_offset_s: 0, invite_ttl_s: 86400, fallback_dest: "fortknox",
};

class Refuse extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code || null; this.extra = extra || null; }
}
const now = () => Date.now();
const str = (v, n) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, n));
const J = (v) => JSON.stringify(v === undefined ? null : v);
const parse = (s, d) => { if (s == null) return d; try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
const low = (s) => String(s || "").trim().replace(/^@+/, "").toLowerCase();
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const P = () => require("./pools");
const tx = (fn) => P()._tx(fn);
const poolKey = (gid) => POOL_PREFIX + gid;

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await P().init();
      await runQuery(`CREATE TABLE IF NOT EXISTS gangs (
        gid TEXT PRIMARY KEY, name TEXT NOT NULL, tag TEXT NOT NULL, boss TEXT, rep INTEGER NOT NULL DEFAULT 0, heat INTEGER,
        wars_w INTEGER NOT NULL DEFAULT 0, wars_l INTEGER NOT NULL DEFAULT 0, has_wars INTEGER NOT NULL DEFAULT 1, unpaid_days INTEGER,
        upgrades TEXT, rank_limits TEXT, withdraw_date TEXT, withdrawn TEXT, created TEXT, extra TEXT, updated INTEGER)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS gangs_tag ON gangs (tag COLLATE NOCASE)");
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS gangs_name ON gangs (name COLLATE NOCASE)");
      await runQuery(`CREATE TABLE IF NOT EXISTS gang_members (
        member_key TEXT PRIMARY KEY, gid TEXT NOT NULL, rank TEXT NOT NULL, userId TEXT, seq INTEGER NOT NULL DEFAULT 0, joined INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS gang_members_gid ON gang_members (gid, seq)");
      await runQuery("CREATE INDEX IF NOT EXISTS gang_members_user ON gang_members (userId)");
      await runQuery("CREATE TABLE IF NOT EXISTS gang_invites (member_key TEXT PRIMARY KEY, gid TEXT NOT NULL, inviter_key TEXT, created INTEGER)");
      await runQuery(`CREATE TABLE IF NOT EXISTS gang_ops (
        key TEXT PRIMARY KEY, gid TEXT, op TEXT NOT NULL, actor_key TEXT, via TEXT, ts INTEGER NOT NULL, result TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS gang_ops_gid ON gang_ops (gid, ts)");
      await runQuery(`CREATE TABLE IF NOT EXISTS gang_rep_events (
        key TEXT PRIMARY KEY, gid TEXT, member_key TEXT, userId TEXT, amount INTEGER NOT NULL, src TEXT, ts INTEGER NOT NULL)`);
      await runQuery("CREATE INDEX IF NOT EXISTS gang_rep_events_gid ON gang_rep_events (gid, ts)");
      await runQuery("CREATE TABLE IF NOT EXISTS gangs_disbanded (gid TEXT PRIMARY KEY, data TEXT NOT NULL, ts INTEGER)");
      await runQuery("CREATE TABLE IF NOT EXISTS gangs_meta (key TEXT PRIMARY KEY, value TEXT)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function meta(key) {
  await init();
  const r = (await getQuery("SELECT value FROM gangs_meta WHERE key = ?", [key]))[0];
  return r ? parse(r.value, null) : null;
}
const setMeta = (key, v) => runQuery("INSERT INTO gangs_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                                      [key, J(v)]);

/** May Pepe hand his gangs over? Default: on on staging (STAGING env), off on prod until an admin turns it on. */
async function enabled() {
  const v = await meta("enabled");
  if (v === true || v === false) return v;
  return !!process.env.STAGING;
}
let liveCache = { at: 0, v: false };
/** The site owns the gangs (an import ran and wasn't rolled back). Cached 2 s (the casino / lotto ask on every win). */
async function live() {
  if (now() - liveCache.at < 2000) return liveCache.v;
  await init();
  const v = !!(await meta("live"));
  liveCache = { at: now(), v };
  return v;
}
const forgetLive = () => { liveCache = { at: 0, v: false }; };
async function rev() { return (await meta("rev")) || 0; }
async function bumpRev() { const r = (await rev()) + 1; await setMeta("rev", r); return r; }
async function cfg() {
  const c = (await meta("cfg")) || {};
  const out = Object.assign({}, DEFAULT_CFG, c);
  out.rank_limits = Object.assign({}, DEFAULT_CFG.rank_limits, c.rank_limits || {});
  out.upgrades = c.upgrades && typeof c.upgrades === "object" && Object.keys(c.upgrades).length ? c.upgrades : DEFAULT_CFG.upgrades;
  return out;
}
async function requireLive() {
  if (!(await live())) throw new Refuse(409, "The gangs still live in Pepe.", "E_NOT_LIVE");
}
function checkKey(k) {
  if (!KEY_RE.test(String(k || ""))) throw new Refuse(400, "Bad request (key).", "E_BAD_KEY");
  return String(k);
}
function checkAmount(a, min = 1) {
  const n = Number(a);
  if (!Number.isSafeInteger(n) || n < min) throw new Refuse(400, "Bad amount.", "E_BAD_AMOUNT");
  return n;
}
function mkey(k) {
  const s = low(k);
  if (!MKEY_RE.test(s)) throw new Refuse(400, "Bad request (member).", "E_BAD_MEMBER");
  return s;
}

// ── reads / Pepe's shape ──
const level = (g, c) => 1 + Math.floor((Number(g.rep) || 0) / (c.rep_per_level || 5000));
function memberCap(g, c) {
  const ups = parse(g.upgrades, {}) || {};
  return (c.base_members || 8) + (level(g, c) - 1) * (c.members_per_level || 2) + (Number(ups.recruiter) || 0) * (c.recruiter_per || 2);
}
function rankLimit(g, rank, c) {
  const own = (parse(g.rank_limits, {}) || {})[rank];
  const v = own === undefined || own === null ? (c.rank_limits || {})[rank] : own;
  return Math.max(0, Math.trunc(Number(v) || 0));
}
async function treasuries() {
  const out = {};
  for (const r of await getQuery("SELECT key, balance FROM pools WHERE key LIKE 'gang:%'")) out[r.key.slice(POOL_PREFIX.length)] = Number(r.balance) || 0;
  return out;
}
async function treasuryOf(gid) {
  const r = (await getQuery("SELECT balance FROM pools WHERE key = ?", [poolKey(gid)]))[0];
  return r ? Number(r.balance) || 0 : 0;
}

/** One gang row + its members -> Pepe's gang_data.json dict (exactly the keys Pepe had; nulls left out). */
function shapeOf(g, members, treasury) {
  const ms = members.slice().sort((a, b) => a.seq - b.seq || (a.member_key < b.member_key ? -1 : 1));
  const out = { name: g.name, tag: g.tag, boss: g.boss };
  out.officers = ms.filter((m) => m.rank === "officer").map((m) => m.member_key);
  out.members = ms.map((m) => m.member_key);
  const rec = ms.filter((m) => m.rank === "recruit").map((m) => m.member_key);
  if (rec.length) out.recruits = rec;
  out.treasury = treasury;
  out.rep = Number(g.rep) || 0;
  if (g.created != null) out.created = g.created;
  if (g.has_wars) out.wars = { wins: Number(g.wars_w) || 0, losses: Number(g.wars_l) || 0 };
  if (g.heat != null) out.heat = Number(g.heat);
  if (g.unpaid_days != null) out.unpaid_days = Number(g.unpaid_days);
  if (g.upgrades != null) out.upgrades = parse(g.upgrades, {});
  if (g.rank_limits != null) out.rank_limits = parse(g.rank_limits, {});
  if (g.withdraw_date != null) out.withdraw_date = g.withdraw_date;
  if (g.withdrawn != null) out.withdrawn = parse(g.withdrawn, {});
  Object.assign(out, parse(g.extra, {}));
  return out;
}
async function gangRow(gid) {
  return (await getQuery("SELECT * FROM gangs WHERE gid = ?", [String(gid)]))[0] || null;
}
async function shapeOne(gid) {
  const g = await gangRow(gid);
  if (!g) return null;
  const ms = await getQuery("SELECT member_key, rank, seq, userId FROM gang_members WHERE gid = ?", [gid]);
  return shapeOf(g, ms, await treasuryOf(gid));
}
/** Everything, in Pepe's gang_data.json shape: {gangs: {gid: {...}}, members: {key: gid}, disbanded: {gid: rec}}. */
async function stateAll() {
  await init();
  const gs = await getQuery("SELECT * FROM gangs ORDER BY gid");
  const ms = await getQuery("SELECT member_key, gid, rank, seq, userId FROM gang_members");
  const tre = await treasuries();
  const by = {};
  for (const m of ms) (by[m.gid] = by[m.gid] || []).push(m);
  const gangs = {}, members = {};
  for (const g of gs) gangs[g.gid] = shapeOf(g, by[g.gid] || [], tre[g.gid] || 0);
  for (const m of ms) members[m.member_key] = m.gid;
  const disbanded = {};
  for (const r of await getQuery("SELECT gid, data FROM gangs_disbanded ORDER BY ts DESC LIMIT 300")) disbanded[r.gid] = parse(r.data, {});
  return { gangs, members, disbanded };
}
function totalsOf(st) {
  const gs = Object.values(st.gangs || {});
  return { gangs: gs.length, members: Object.keys(st.members || {}).length,
           treasury: gs.reduce((t, g) => t + Math.trunc(Number(g.treasury) || 0), 0), rep: gs.reduce((t, g) => t + Math.trunc(Number(g.rep) || 0), 0) };
}
/** sha256 of the money + roster facts both sides compare (treasury, rep, tag, boss, members by rank) - not the engine fields. */
function digestOf(st) {
  const gs = st.gangs || {};
  const rows = Object.keys(gs).sort().map((gid) => {
    const g = gs[gid];
    return [gid, String(g.tag), String(g.boss), Math.trunc(Number(g.treasury) || 0), Math.trunc(Number(g.rep) || 0),
            (g.members || []).map(String).sort(), (g.officers || []).map(String).sort()];
  });
  return crypto.createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex");
}

// ── identity ──
async function memberRow(key) {
  return (await getQuery("SELECT * FROM gang_members WHERE member_key = ?", [String(key)]))[0] || null;
}
/** The web viewer's membership: by account, else by their linked Camfrog name. */
async function webMember(userId) {
  if (!userId) return null;
  const r = (await getQuery("SELECT * FROM gang_members WHERE userId = ? ORDER BY seq LIMIT 1", [userId]))[0];
  if (r) return r;
  const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [userId]))[0];
  if (u && u.camfrogUsername) return memberRow(low(u.camfrogUsername));
  return null;
}
/** The member key for a PATV account (its Camfrog login when linked, else "u:<userId>"). */
function keyForUser(u) {
  return u && u.camfrogUsername ? low(u.camfrogUsername) : "u:" + u.userId;
}
async function userFor({ userId, username }) {
  // 1.99tc: a merged-away userId follows the merge; an old (renamed / merged) username resolves via usernames.js
  if (userId || username) {
    const r = await require("./usernames").resolveRecord({ userId, username });
    return r.ok ? r.user : null;
  }
  return null;
}

// ── the op journal ──
async function opSeen(key) {
  const r = (await getQuery("SELECT result FROM gang_ops WHERE key = ?", [key]))[0];
  if (!r) return null;
  return Object.assign(parse(r.result, { ok: true }), { dup: true });
}
async function opStatus(key) {
  await init();
  if (!KEY_RE.test(String(key || ""))) return null;
  const r = (await getQuery("SELECT result FROM gang_ops WHERE key = ?", [String(key)]))[0];
  return r ? parse(r.result, { ok: true }) : null;
}
/**
 * PO-0b (the owner's 2026-10-20 finding (b)): Pepe's /api/gangs/bot/op-status - the same answer, read in a transaction of
 * its own on the chain, like the 1.99adl stash / pool move_status (settledMoveStatus): queued behind every transaction
 * already waiting (an op Pepe gave up on that reached the site first is answered, not "not yet"), from committed rows
 * only (never an OPEN transaction's gang_ops row that a rollback then takes back). Pepe reads null as "no record YET".
 */
async function settledOpStatus(key) {
  await init();
  if (!KEY_RE.test(String(key || ""))) return null;
  return tx(() => opStatus(key));
}
/**
 * Run one keyed op in ONE transaction: a key seen before answers its first result (dup) and changes nothing. A refusal
 * (Refuse) rolls everything back and is NOT recorded, so a retry with the same key may still succeed (the pools' rule).
 */
async function runOp(key, op, actorKey, via, fn) {
  await requireLive();
  key = checkKey(key);
  const res = await tx(async () => {
    const dup = await opSeen(key);
    if (dup) return dup;
    const out = Object.assign({ ok: true, key, op }, (await fn()) || {});
    if (out.gid && out.gang === undefined) out.gang = await shapeOne(out.gid);
    out.rev = await bumpRev();
    await runQuery("INSERT INTO gang_ops (key, gid, op, actor_key, via, ts, result) VALUES (?, ?, ?, ?, ?, ?, ?)",
                   [key, str(out.gid, 40), op, str(actorKey, 80), str(via, 20), now(), J(out)]);
    return out;
  });
  return res;
}
const touch = (gid) => runQuery("UPDATE gangs SET updated = ? WHERE gid = ?", [now(), gid]);

// ── money legs (inside an open transaction) ──
/** Treasury / protocol-pool legs [[pool, amount]], applied all-or-nothing through pools.js; the move recorded under mk. */
async function poolLegs(mk, legs, { kind = "gang", flow = null, why = null, via = "pepe" } = {}) {
  if (!legs.length) return { after: {}, net: 0 };
  const a = await P()._applyLegs(mk, legs, { kind, flow, why, via });
  await P()._recordMove(mk, { kind, flow, why, via, legs, net: a.net, ts: a.ts, result: { ok: true, key: mk, balances: a.after } });
  await P()._bumpRev();
  return a;
}
function insufficientToRefuse(e, gid, what) {
  if (e instanceof P().Refuse && e.code === "E_INSUFFICIENT") {
    const isGang = e.extra && String(e.extra.pool || "").startsWith(POOL_PREFIX);
    return new Refuse(409, isGang ? `the treasury only holds ${fmt(e.extra.balance)} PAT${what ? ` - can't ${what}` : ""}.`
                                  : e.message, isGang ? "E_TREASURY" : "E_INSUFFICIENT", Object.assign({ gid }, e.extra || {}));
  }
  return e;
}
/** Split a routed amount like Pepe's _route_split (shares in order, int(), the rest to the Reserve). */
function splitShares(shares, amount) {
  const out = [];
  let used = 0;
  for (const [d, p] of shares || []) {
    const a = Math.trunc(amount * Number(p) / 100);
    if (a > 0) { out.push([String(d), a]); used += a; }
  }
  const rest = amount - used;
  if (rest > 0) {
    const i = out.findIndex(([d]) => d === "reserve");
    if (i >= 0) out[i] = [out[i][0], out[i][1] + rest]; else out.push(["reserve", rest]);
  }
  return out;
}
/** The withdrawal cut's legs: the routing override for gang_withdraw_cut, else Pepe's pushed shares (Fort Knox 100%). */
async function cutLegs(cut, c) {
  if (cut <= 0) return [];
  let shares = null;
  try { shares = (await require("./econstore").getSettings()).pat_routes.gang_withdraw_cut || null; } catch (e) { shares = null; }
  if (!Array.isArray(shares) || !shares.length) shares = c.cut_shares || [["fortknox", 100]];
  return splitShares(shares, cut).map(([d, a]) => [VAULT_DESTS.has(d) && d !== "jackpot" ? d : "reserve", a]);
}
function cleanCutLegs(raw, cut) {
  const legs = (Array.isArray(raw) ? raw : []).map((l) => [String((l || [])[0] || ""), Number((l || [])[1])]);
  if (legs.some(([d, a]) => !VAULT_DESTS.has(d) || d === "jackpot" || !Number.isSafeInteger(a) || a <= 0) ||
      legs.reduce((t, [, a]) => t + a, 0) !== cut) throw new Refuse(400, "Bad request (cut legs).", "E_BAD_LEGS");
  return legs;
}
/**
 * Routed legs of a spend (Pepe priced and split it by his PAT Routing table): the House leg = a jackpot_rakes row, a site
 * pool = a pool leg, anything else (a turf business) = a turf_inbox row Pepe applies once (pools.js's charge rules).
 */
async function bookRouted(mk, key, split, route, payerUid) {
  const pools = P();
  const lottoSvc = await pools._lottoIsService();
  const legs = [], inbox = [], house = [];
  const t = now();
  for (let i = 0; i < split.length; i++) {
    const [dest, a] = split[i];
    if (dest === "jackpot" || dest === "casino") {
      await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
                     [`gr-${key}-${i}`, `bot:route:${route.flow}`.slice(0, 80), payerUid || null, a]);
      house.push(i);
    } else if (pools.isPool(dest) && !(dest === "lotto" && lottoSvc)) {
      legs.push({ pool: dest, amount: a });
    } else {
      const ik = `gr-${key}-${i}`;
      await runQuery(`INSERT INTO turf_inbox (key, route_key, i, flow, dest, amount, item_sink, room, payer, base, created)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                     [ik, key, i, route.flow, dest, a, str(route.item_sink, 64), str(route.room, 120), str(route.payer, 80),
                      split.reduce((s, [, x]) => s + x, 0), t]);
      inbox.push({ i, key: ik, dest, amount: a });
    }
  }
  return { legs, inbox, house };
}
function cleanSplit(raw, amount) {
  const split = (Array.isArray(raw) ? raw : []).map((l) => [String(Array.isArray(l) ? l[0] : (l && l.dest) || ""), Number(Array.isArray(l) ? l[1] : l && l.amount)]);
  if (!split.length || split.length > MAX_LEGS || split.some(([d, a]) => !d || d.length > 120 || !Number.isSafeInteger(a) || a <= 0) ||
      split.reduce((t, [, a]) => t + a, 0) !== amount) throw new Refuse(400, "Bad request (legs).", "E_BAD_LEGS");
  return split;
}

// ── the ops ──
async function needMember(key, what) {
  const m = await memberRow(key);
  if (!m) throw new Refuse(409, what || "you're not in a gang.", "E_NOT_MEMBER");
  return m;
}
async function needGang(gid) {
  const g = await gangRow(gid);
  if (!g) throw new Refuse(404, "That gang doesn't exist.", "E_NO_GANG");
  return g;
}
const manages = (m, admin) => admin || m.rank === "owner" || m.rank === "officer";
async function nextSeq(gid) {
  return Number(((await getQuery("SELECT COALESCE(MAX(seq), -1) AS s FROM gang_members WHERE gid = ?", [gid]))[0] || {}).s) + 1;
}
function todayFor(c) {
  return new Date(now() + (Number(c.tz_offset_s) || 0) * 1000).toISOString().slice(0, 10);
}

/** !gang create: the founding fee (routed, from the founder's wallet) + the gang, in one transaction. */
async function create(b, via) {
  const c = await cfg();
  const member = mkey(b.member);
  const name = String(b.name || "").trim().replace(/\s+/g, " ");
  const tag = String(b.tag || "").toUpperCase();
  const fee = checkAmount(b.fee, 0);
  return runOp(b.key, "create", member, via, async () => {
    if (await memberRow(member)) throw new Refuse(409, "you're already in a gang - leave it first.", "E_IN_GANG");
    if (name.length < c.name_min || name.length > c.name_max) throw new Refuse(400, `gang name must be ${c.name_min}-${c.name_max} characters.`, "E_NAME");
    if (!/^[A-Z0-9]+$/.test(tag) || tag.length < c.tag_min || tag.length > c.tag_max) throw new Refuse(400, `tag must be ${c.tag_min}-${c.tag_max} letters/numbers.`, "E_TAG");
    if ((await getQuery("SELECT 1 FROM gangs WHERE name = ? COLLATE NOCASE", [name])).length) throw new Refuse(409, "a gang with that name already exists.", "E_NAME_TAKEN");
    if ((await getQuery("SELECT 1 FROM gangs WHERE tag = ? COLLATE NOCASE", [tag])).length) throw new Refuse(409, `tag [${tag}] is already taken - pick another.`, "E_TAG_TAKEN");
    const u = await userFor({ userId: b.userId, username: b.username });
    if (!u) throw new Refuse(404, "Couldn't find a PAT account.", "E_TARGET_NOT_FOUND");
    const gid = /^[a-f0-9]{8}$/.test(String(b.gid || "")) ? String(b.gid) : crypto.randomBytes(4).toString("hex");
    if (await gangRow(gid)) throw new Refuse(409, "gang id clash - try again.", "E_RETRY");
    let charged = null;
    if (fee > 0) {
      const split = cleanSplit(b.legs || [["reserve", fee]], fee);
      const ledger = require("./ledger");
      const d = await ledger.post(u.userId, -fee, "gang-create", { requireCover: true, source: "gang-create" });
      if (!d.ok) throw new Refuse(d.code === ledger.E_INSUFFICIENT ? 402 : 404, d.code === ledger.E_INSUFFICIENT ? "insufficient PAT" : "no account",
                                  d.code === ledger.E_INSUFFICIENT ? "E_INSUFFICIENT_PAT" : "E_TARGET_NOT_FOUND");
      const route = Object.assign({ flow: "gangcreate" }, b.route || {});
      const r = await bookRouted("g:" + b.key, b.key, split, route, u.userId);
      await poolLegs("g:" + b.key, r.legs, { kind: "charge", flow: route.flow, why: "gang-create" });
      charged = { transactionId: d.transactionId, inbox: r.inbox, house: r.house, split };
    }
    await runQuery(`INSERT INTO gangs (gid, name, tag, boss, rep, wars_w, wars_l, has_wars, created, updated) VALUES (?, ?, ?, ?, 0, 0, 0, 1, ?, ?)`,
                   [gid, name, tag, member, todayFor(c), now()]);
    await runQuery("INSERT INTO gang_members (member_key, gid, rank, userId, seq, joined) VALUES (?, ?, 'owner', ?, 0, ?)", [member, gid, u.userId, now()]);
    await runQuery("INSERT INTO pools (key, label, balance, updated) VALUES (?, ?, 0, ?) ON CONFLICT(key) DO NOTHING", [poolKey(gid), `🎩 [${tag}] treasury`, now()]);
    await runQuery("DELETE FROM gang_invites WHERE member_key = ?", [member]);
    return { gid, charged };
  });
}

async function invite(b, via) {
  const actor = mkey(b.actor), target = mkey(b.target);
  return runOp(b.key, "invite", actor, via, async () => {
    const m = await needMember(actor);
    if (!manages(m, b.admin)) throw new Refuse(403, "only the boss or officers can invite.", "E_RANK");
    const g = await needGang(m.gid);
    const c = await cfg();
    const t = await memberRow(target);
    if (t && t.gid === m.gid) throw new Refuse(409, "they're already in the gang.", "E_IN_GANG");
    if (t) throw new Refuse(409, "they're already in another gang.", "E_IN_GANG");
    const n = Number((await getQuery("SELECT COUNT(*) AS n FROM gang_members WHERE gid = ?", [m.gid]))[0].n);
    if (n >= memberCap(g, c)) throw new Refuse(409, `gang is full (${memberCap(g, c)}) - level up for more slots.`, "E_FULL");
    await runQuery(`INSERT INTO gang_invites (member_key, gid, inviter_key, created) VALUES (?, ?, ?, ?)
                    ON CONFLICT(member_key) DO UPDATE SET gid = excluded.gid, inviter_key = excluded.inviter_key, created = excluded.created`,
                   [target, m.gid, actor, now()]);
    return { gid: m.gid, target };
  });
}

async function accept(b, via) {
  const member = mkey(b.member);
  return runOp(b.key, "accept", member, via, async () => {
    if (await memberRow(member)) throw new Refuse(409, "you're already in a gang.", "E_IN_GANG");
    const c = await cfg();
    const inv = (await getQuery("SELECT * FROM gang_invites WHERE member_key = ?", [member]))[0];
    if (!inv || (b.gid && b.gid !== inv.gid) || now() - Number(inv.created || 0) > c.invite_ttl_s * 1000) {
      throw new Refuse(409, "you don't have a pending gang invite.", "E_NO_INVITE");
    }
    const g = await gangRow(inv.gid);
    if (!g) { await runQuery("DELETE FROM gang_invites WHERE member_key = ?", [member]); throw new Refuse(409, "you don't have a pending gang invite.", "E_NO_INVITE"); }
    const n = Number((await getQuery("SELECT COUNT(*) AS n FROM gang_members WHERE gid = ?", [g.gid]))[0].n);
    if (n >= memberCap(g, c)) throw new Refuse(409, "that gang filled up before you joined.", "E_FULL");
    const u = await userFor({ userId: b.userId, username: b.username });
    await runQuery("INSERT INTO gang_members (member_key, gid, rank, userId, seq, joined) VALUES (?, ?, 'member', ?, ?, ?)",
                   [member, g.gid, u ? u.userId : null, await nextSeq(g.gid), now()]);
    await runQuery("DELETE FROM gang_invites WHERE member_key = ?", [member]);
    await touch(g.gid);
    return { gid: g.gid, strength: n + 1 };
  });
}

async function decline(b) {
  await requireLive();
  const member = mkey(b.member);
  const r = await runQuery("DELETE FROM gang_invites WHERE member_key = ?", [member]);
  if (r && r.changes) await bumpRev();
  return { ok: true, declined: !!(r && r.changes) };
}

async function leaveLike(b, via, op) {
  const member = mkey(b.member);
  return runOp(b.key, op, member, via, async () => {
    const m = await needMember(member);
    const g = await needGang(m.gid);
    if (m.rank === "owner") throw new Refuse(409, op === "defect" ? "you're the boss - hand over with !gang boss @user or !gang disband."
                                                                  : "the boss can't just leave - hand it over first, or disband.", "E_BOSS");
    if (op === "defect") {
      const c = await cfg();
      if ((Number(g.unpaid_days) || 0) < c.defect_days) throw new Refuse(409, `[${g.tag}] is paying its way - no grounds to defect.`, "E_NO_GROUNDS",
                                                                          { unpaid: Number(g.unpaid_days) || 0, need: c.defect_days });
    }
    await runQuery("DELETE FROM gang_members WHERE member_key = ?", [member]);
    await touch(g.gid);
    return { gid: g.gid, unpaid: Number(g.unpaid_days) || 0 };
  });
}

async function kick(b, via) {
  const actor = mkey(b.actor), target = mkey(b.target);
  return runOp(b.key, "kick", actor, via, async () => {
    const m = await needMember(actor);
    if (!manages(m, b.admin)) throw new Refuse(403, "only the boss or officers can kick.", "E_RANK");
    const t = await memberRow(target);
    if (!t || t.gid !== m.gid) throw new Refuse(409, "they're not in your gang.", "E_NOT_MEMBER");
    if (t.rank === "owner") throw new Refuse(409, "you can't kick the boss.", "E_BOSS");
    if (t.rank === "officer" && m.rank !== "owner" && !b.admin) throw new Refuse(403, "only the boss can kick an officer.", "E_RANK");
    await runQuery("DELETE FROM gang_members WHERE member_key = ?", [target]);
    await touch(m.gid);
    return { gid: m.gid, target };
  });
}

async function role(b, via) {
  const actor = mkey(b.actor), target = mkey(b.target);
  const promote = !!b.promote;
  return runOp(b.key, promote ? "promote" : "demote", actor, via, async () => {
    const m = await needMember(actor);
    if (m.rank !== "owner" && !b.admin) throw new Refuse(403, "only the boss can promote/demote.", "E_RANK");
    const t = await memberRow(target);
    if (!t || t.gid !== m.gid || t.rank === "owner") throw new Refuse(409, "pick a gang member (not the boss).", "E_NOT_MEMBER");
    if (promote && t.rank === "officer") throw new Refuse(409, "already an officer.", "E_SAME");
    if (!promote && t.rank !== "officer") throw new Refuse(409, "they're not an officer.", "E_SAME");
    await runQuery("UPDATE gang_members SET rank = ? WHERE member_key = ?", [promote ? "officer" : "member", target]);
    await touch(m.gid);
    return { gid: m.gid, target };
  });
}

async function setBoss(b, via) {
  const actor = mkey(b.actor), target = mkey(b.target);
  return runOp(b.key, "boss", actor, via, async () => {
    const m = await needMember(actor);
    if (m.rank !== "owner" && !b.admin) throw new Refuse(403, "only the boss can hand over leadership.", "E_RANK");
    const g = await needGang(m.gid);
    const t = await memberRow(target);
    if (!t || t.gid !== m.gid || t.rank === "owner") throw new Refuse(409, "pick another gang member to make boss.", "E_NOT_MEMBER");
    await runQuery("UPDATE gang_members SET rank = 'officer' WHERE gid = ? AND rank = 'owner'", [m.gid]);   // the ex-boss becomes an officer
    await runQuery("UPDATE gang_members SET rank = 'owner' WHERE member_key = ?", [target]);
    await runQuery("UPDATE gangs SET boss = ?, updated = ? WHERE gid = ?", [target, now(), g.gid]);
    return { gid: m.gid, target, old: g.boss };
  });
}

async function setTag(b, via) {
  const actor = mkey(b.actor);
  const tag = String(b.tag || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return runOp(b.key, "tag", actor, via, async () => {
    const c = await cfg();
    const m = await needMember(actor);
    if (m.rank !== "owner" && !b.admin) throw new Refuse(403, "only the boss can set the tag.", "E_RANK");
    if (tag.length < c.tag_min || tag.length > c.tag_max) throw new Refuse(400, `tag must be ${c.tag_min}-${c.tag_max} letters/numbers.`, "E_TAG");
    if ((await getQuery("SELECT 1 FROM gangs WHERE tag = ? COLLATE NOCASE AND gid != ?", [tag, m.gid])).length) throw new Refuse(409, "that tag is taken.", "E_TAG_TAKEN");
    await runQuery("UPDATE gangs SET tag = ?, updated = ? WHERE gid = ?", [tag, now(), m.gid]);
    await runQuery("UPDATE pools SET label = ? WHERE key = ?", [`🎩 [${tag}] treasury`, poolKey(m.gid)]);
    return { gid: m.gid, tag };
  });
}

async function limits(b, via) {
  const actor = mkey(b.actor);
  const rank = String(b.rank || "").toLowerCase();
  return runOp(b.key, "limits", actor, via, async () => {
    const m = await needMember(actor);
    if (m.rank !== "owner" && !b.admin) throw new Refuse(403, "only the boss can set withdrawal allowances.", "E_RANK");
    if (!RANKS.includes(rank)) throw new Refuse(400, `rank must be one of: ${RANKS.join(", ")}.`, "E_RANK_NAME");
    const amt = Math.max(0, checkAmount(b.amount, 0));
    const g = await needGang(m.gid);
    const rl = parse(g.rank_limits, {}) || {};
    rl[rank] = amt;
    await runQuery("UPDATE gangs SET rank_limits = ?, updated = ? WHERE gid = ?", [J(rl), now(), g.gid]);
    return { gid: g.gid, rank, amount: amt };
  });
}

/** Wallet -> treasury, one transaction. */
async function deposit(b, via) {
  const member = mkey(b.member);
  const amt = checkAmount(b.amount);
  return runOp(b.key, "deposit", member, via, async () => {
    const m = await needMember(member);
    const g = await needGang(m.gid);
    const u = await userFor({ userId: b.userId || m.userId, username: b.username });
    if (!u) throw new Refuse(404, "Couldn't find a PAT account.", "E_TARGET_NOT_FOUND");
    const ledger = require("./ledger");
    const d = await ledger.post(u.userId, -amt, "gang-deposit", { requireCover: true, source: "gang-deposit" });
    if (!d.ok) throw new Refuse(d.code === ledger.E_INSUFFICIENT ? 402 : 404, d.code === ledger.E_INSUFFICIENT ? "insufficient PAT" : "no account",
                                d.code === ledger.E_INSUFFICIENT ? "E_INSUFFICIENT_PAT" : "E_TARGET_NOT_FOUND");
    const a = await poolLegs("g:" + b.key, [{ pool: poolKey(g.gid), amount: amt }], { kind: "gang", flow: "gang_deposit", why: "gang-deposit", via });
    await touch(g.gid);
    return { gid: g.gid, amount: amt, treasury: a.after[poolKey(g.gid)], transactionId: d.transactionId, tag: g.tag, name: g.name };
  });
}

/** Treasury -> the member's wallet (net) + the cut's legs (Fort Knox by default), with the per-rank daily allowance. */
async function withdraw(b, via) {
  const member = mkey(b.member);
  const amt = checkAmount(b.amount);
  return runOp(b.key, "withdraw", member, via, async () => {
    const c = await cfg();
    const m = await needMember(member);
    const g = await needGang(m.gid);
    const tre = await treasuryOf(g.gid);
    if (tre < amt) throw new Refuse(409, `treasury only holds ${fmt(tre)} PAT.`, "E_TREASURY", { treasury: tre });
    const today = todayFor(c);
    let taken = parse(g.withdrawn, {}) || {};
    let date = g.withdraw_date;
    if (date !== today) { date = today; taken = {}; }
    const limit = rankLimit(g, m.rank, c);
    if (limit) {
      const room = limit - (Number(taken[member]) || 0);
      if (room <= 0) throw new Refuse(409, `you've taken your ${m.rank} allowance of ${fmt(limit)} PAT today - resets tomorrow.`, "E_ALLOWANCE", { limit, room: 0, rank: m.rank });
      if (amt > room) throw new Refuse(409, `your ${m.rank} allowance is ${fmt(limit)} PAT/day - you can take ${fmt(room)} more today.`, "E_ALLOWANCE", { limit, room, rank: m.rank });
    }
    const cut = Math.trunc(amt * Number(c.cut_rate));
    const net = amt - cut;
    const cl = b.cut_legs ? cleanCutLegs(b.cut_legs, cut) : await cutLegs(cut, c);
    const u = await userFor({ userId: b.userId || m.userId, username: b.username });
    if (!u) throw new Refuse(404, "Couldn't find a PAT account.", "E_TARGET_NOT_FOUND");
    const legs = [{ pool: poolKey(g.gid), amount: -amt }, ...cl.map(([d, a]) => ({ pool: d, amount: a }))];
    let a;
    try { a = await poolLegs("g:" + b.key, legs, { kind: "gang", flow: "gang_withdraw_cut", why: "gang-withdraw", via }); } catch (e) { throw insufficientToRefuse(e, g.gid, "withdraw that"); }
    if (net > 0) {
      const cr = await require("./ledger").post(u.userId, net, "gang-withdraw", { resolveMerged: true, source: "pepe:gang_treasury" });
      if (!cr.ok) throw new Refuse(404, "Couldn't find the account to pay.", "E_TARGET_NOT_FOUND");      // rolls the treasury back
    }
    taken[member] = (Number(taken[member]) || 0) + amt;
    await runQuery("UPDATE gangs SET withdrawn = ?, withdraw_date = ?, updated = ? WHERE gid = ?", [J(taken), date, now(), g.gid]);
    return { gid: g.gid, amount: amt, cut, net, cut_legs: cl, treasury: a.after[poolKey(g.gid)], rank: m.rank, limit,
             used: taken[member], tag: g.tag, name: g.name };
  });
}

/**
 * Treasury spend routed by Pepe's table (gang upgrades, borough upgrades): the treasury leg + the routed legs (+ the
 * upgrade level when `upgrade` is given - checked against the gang's level and the cost here).
 */
async function spend(b, via) {
  const actor = b.actor ? mkey(b.actor) : null;
  const amt = checkAmount(b.amount);
  return runOp(b.key, "spend", actor, via, async () => {
    let gid = b.gid ? String(b.gid) : null;
    if (actor) {
      const m = await needMember(actor);
      if (!manages(m, b.admin)) throw new Refuse(403, "only the boss or officers can spend the treasury.", "E_RANK");
      if (gid && gid !== m.gid) throw new Refuse(409, "not your gang.", "E_NOT_MEMBER");
      gid = m.gid;
    }
    const g = await needGang(gid);
    let up = null;
    if (b.upgrade) {
      const c = await cfg();
      const k = String(b.upgrade.key || "");
      const def = (c.upgrades || {})[k];
      if (!def) throw new Refuse(400, "unknown upgrade.", "E_UPGRADE");
      const ups = parse(g.upgrades, {}) || {};
      const lvl = Number(ups[k]) || 0;
      if (lvl >= def.max) throw new Refuse(409, `${def.name} is already maxed (Lv${def.max}).`, "E_MAXED");
      if (lvl + 1 > level(g, c)) throw new Refuse(409, `${def.name} Lv${lvl + 1} needs gang level ${lvl + 1} - earn more rep first.`, "E_LEVEL");
      if (def.cost * (lvl + 1) !== amt) throw new Refuse(409, "the upgrade's price changed - try again.", "E_PRICE");
      ups[k] = lvl + 1;
      up = { key: k, lvl: lvl + 1, name: def.name, desc: def.desc, ups };
    }
    const split = cleanSplit(b.legs || [["reserve", amt]], amt);
    const route = Object.assign({ flow: String(b.flow || "turf_upgrades").slice(0, 64) }, b.route || {});
    const r = await bookRouted("g:" + b.key, b.key, split, route, null);
    try {
      await poolLegs("g:" + b.key, [{ pool: poolKey(g.gid), amount: -amt }, ...r.legs], { kind: "gang", flow: route.flow, why: str(b.why, 60) || "gang-spend", via });
    } catch (e) { throw insufficientToRefuse(e, g.gid, "pay that"); }
    if (up) await runQuery("UPDATE gangs SET upgrades = ?, updated = ? WHERE gid = ?", [J(up.ups), now(), g.gid]);
    else await touch(g.gid);
    return { gid: g.gid, amount: amt, treasury: await treasuryOf(g.gid), inbox: r.inbox, house: r.house, split, upgrade: up ? { key: up.key, lvl: up.lvl } : null };
  });
}

/**
 * Pepe only: treasury legs with the other side in his turf store, and/or protocol-pool legs - one keyed move.
 * legs: [["gang:<gid>" | "gang" (= b.gid), amount], [pool, amount], ["jackpot", +amount]]. A gang leg's gang must exist.
 */
async function move(b, via) {
  return runOp(b.key, "move", null, via, async () => {
    const raw = Array.isArray(b.legs) ? b.legs : [];
    if (!raw.length || raw.length > MAX_LEGS) throw new Refuse(400, "Bad request (legs).", "E_BAD_LEGS");
    const legs = [], gids = new Set();
    let house = 0;
    for (const l of raw) {
      let pool = String((l || [])[0] || "");
      const a = Number((l || [])[1]);
      if (!Number.isSafeInteger(a) || a === 0) throw new Refuse(400, "Bad request (legs).", "E_BAD_LEGS");
      if (pool === "gang") pool = poolKey(String(b.gid || ""));
      if (pool.startsWith(POOL_PREFIX)) {
        const gid = pool.slice(POOL_PREFIX.length);
        if (!GID_RE.test(gid)) throw new Refuse(400, "Bad request (gang).", "E_BAD_LEGS");
        if (!(await gangRow(gid))) throw new Refuse(404, "That gang doesn't exist.", "E_NO_GANG", { gid });
        gids.add(gid);
        legs.push({ pool, amount: a });
      } else if (pool === "jackpot") {
        if (a < 0) throw new Refuse(400, "The House only takes here.", "E_BAD_LEGS");
        house += a;
      } else if (P().isPool(pool) && pool !== "burn") {
        legs.push({ pool, amount: a });
      } else throw new Refuse(400, `Bad leg ${pool.slice(0, 40)}.`, "E_BAD_LEGS");
    }
    if (house) await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, NULL, ?)", [`gm-${b.key}`, `bot:gang:${str(b.flow, 40) || "move"}`, house]);
    let a;
    try { a = await poolLegs("g:" + b.key, legs, { kind: "gang", flow: str(b.flow, 64), why: str(b.why, 120), via }); } catch (e) { throw insufficientToRefuse(e, [...gids][0]); }
    for (const gid of gids) await touch(gid);
    const tre = {};
    for (const gid of gids) tre[gid] = a.after[poolKey(gid)];
    return { gid: gids.size === 1 ? [...gids][0] : null, gang: gids.size === 1 ? undefined : null, treasuries: tre, balances: a.after, house };
  });
}

/**
 * !gang disband: the treasury plus the stakes of the boroughs Pepe releases (`stakes`, PAT he takes out of his turf store)
 * split evenly among the members (keyed wallet credits), the dust to the Reserve; the gang's record kept for the turf code.
 */
async function disband(b, via) {
  const actor = mkey(b.actor);
  return runOp(b.key, "disband", actor, via, async () => {
    const m = await needMember(actor);
    if (m.rank !== "owner" && !b.admin) throw new Refuse(403, "only the boss can disband.", "E_RANK");
    const g = await needGang(m.gid);
    const stakes = Math.max(0, Math.trunc(Number(b.stakes) || 0));
    const released = b.released && typeof b.released === "object" ? b.released : {};
    const ms = await getQuery("SELECT member_key, userId FROM gang_members WHERE gid = ? ORDER BY seq", [g.gid]);
    const tre = await treasuryOf(g.gid);
    const total = tre + stakes;
    const per = ms.length ? Math.floor(total / ms.length) : 0;
    const dust = ms.length ? total - per * ms.length : total;
    const rid = String(b.rid || `disband-${g.gid}-${Math.floor(now() / 1000)}`).slice(0, 80);
    const fb = VAULT_DESTS.has(String(b.fallback_dest || "")) ? String(b.fallback_dest) : (await cfg()).fallback_dest || "fortknox";
    const legs = [];
    if (tre) legs.push({ pool: poolKey(g.gid), amount: -tre });
    const ledger = require("./ledger");
    const paid = {};
    let parked = 0;
    for (const x of ms) {
      if (per <= 0) break;
      const cr = x.userId ? await ledger.post(x.userId, per, "gang-disband", { resolveMerged: true, source: "pepe:gang_treasury" }) : { ok: false };
      if (cr.ok) paid[x.member_key] = Math.floor(now() / 1000);
      else { paid[x.member_key] = "vault"; parked += per; }
    }
    if (parked) legs.push({ pool: fb, amount: parked });
    if (dust > 0) legs.push({ pool: "reserve", amount: dust });
    await poolLegs("g:" + b.key, legs, { kind: "gang", flow: "gang_disband", why: "gang disband", via });
    const rec = { rid, tag: g.tag, name: g.name, boss: g.boss, by: actor, ts: Math.floor(now() / 1000), members: ms.map((x) => x.member_key),
                  treasury: tre, released, payouts: per > 0 ? Object.fromEntries(ms.map((x) => [x.member_key, per])) : {}, paid, dust,
                  dust_done: 1, done: Math.floor(now() / 1000), site: true };
    await runQuery("INSERT INTO gangs_disbanded (gid, data, ts) VALUES (?, ?, ?) ON CONFLICT(gid) DO UPDATE SET data = excluded.data, ts = excluded.ts",
                   [g.gid, J(rec), now()]);
    await runQuery("DELETE FROM gang_members WHERE gid = ?", [g.gid]);
    await runQuery("DELETE FROM gang_invites WHERE gid = ?", [g.gid]);
    await runQuery("DELETE FROM gangs WHERE gid = ?", [g.gid]);
    await runQuery("DELETE FROM pools WHERE key = ? AND balance = 0", [poolKey(g.gid)]);
    return { gid: g.gid, gang: null, disbanded: rec, per, total, dust, parked };
  });
}

/** Pepe only: the engine fields he owns (heat, unpaid days, war record, extra fields); `reset_withdrawn` = the tick's reset. */
async function patch(b, via) {
  return runOp(b.key, "patch", null, via, async () => {
    const g = await needGang(String(b.gid || ""));
    const s = b.set && typeof b.set === "object" ? b.set : {};
    const sets = [], vals = [];
    const int = (v) => (v === null ? null : Math.trunc(Number(v) || 0));
    if ("heat" in s) { sets.push("heat = ?"); vals.push(int(s.heat)); }
    if ("unpaid_days" in s) { sets.push("unpaid_days = ?"); vals.push(int(s.unpaid_days)); }
    if (s.wars && typeof s.wars === "object") { sets.push("wars_w = ?", "wars_l = ?", "has_wars = 1"); vals.push(int(s.wars.wins), int(s.wars.losses)); }
    if (s.extra && typeof s.extra === "object") {
      const ex = parse(g.extra, {}) || {};
      for (const [k, v] of Object.entries(s.extra)) {
        if (!/^[A-Za-z0-9_]{1,40}$/.test(k) || KNOWN.has(k) || NO_EXTRA.has(k)) continue;
        if (v === null || v === undefined) delete ex[k]; else ex[k] = v;
      }
      const t = J(ex);
      if (t.length > 20000) throw new Refuse(400, "extra too large", "E_TOO_LARGE");
      sets.push("extra = ?"); vals.push(t);
    }
    if (b.reset_withdrawn) { sets.push("withdrawn = ?", "withdraw_date = ?"); vals.push(J({}), null); }
    if (!sets.length) return { gid: g.gid };
    sets.push("updated = ?"); vals.push(now());
    await runQuery(`UPDATE gangs SET ${sets.join(", ")} WHERE gid = ?`, [...vals, g.gid]);
    return { gid: g.gid };
  });
}

// ── rep ──
/**
 * Rep events, each once per key: [{key, member? | userId? | camfrog?, amount, src}]. The member's gang now (no gang =
 * recorded with gid NULL, so the key is spent). Off the hot path: Pepe batches them; the casino / lotto call addRep.
 */
async function applyRep(events) {
  await requireLive();
  const list = (Array.isArray(events) ? events : []).slice(0, 500);
  const out = { applied: 0, dup: 0, nogang: 0, bad: 0 };
  if (!list.length) return out;
  await tx(async () => {
    for (const ev of list) {
      const key = String((ev && ev.key) || "");
      const amt = Math.trunc(Number(ev && ev.amount) || 0);
      if (!KEY_RE.test(key) || amt <= 0 || amt > 1e9) { out.bad++; continue; }
      if ((await getQuery("SELECT 1 FROM gang_rep_events WHERE key = ?", [key])).length) { out.dup++; continue; }
      let m = null;
      if (ev.member) m = await memberRow(low(ev.member));
      if (!m && ev.userId) m = (await getQuery("SELECT * FROM gang_members WHERE userId = ? ORDER BY seq LIMIT 1", [String(ev.userId)]))[0] || null;
      if (!m && ev.camfrog) m = await memberRow(low(ev.camfrog));
      await runQuery("INSERT INTO gang_rep_events (key, gid, member_key, userId, amount, src, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
                     [key, m ? m.gid : null, m ? m.member_key : str(low(ev.member || ev.camfrog), 80), m ? m.userId : str(ev.userId, 64), amt, str(ev.src, 20), now()]);
      if (!m) { out.nogang++; continue; }
      await runQuery("UPDATE gangs SET rep = rep + ?, updated = ? WHERE gid = ?", [amt, now(), m.gid]);
      out.applied++;
    }
    if (out.applied) await bumpRev();
  });
  return out;
}
/** A site win's rep (casino, lotto): true when the gangs are live and it was handled here (Pepe must not get it then). */
async function addRep({ key, userId, camfrog, amount, src }) {
  try {
    if (!(await live())) return false;
    await applyRep([{ key, userId, camfrog, amount, src }]);
    return true;
  } catch (e) {
    console.error("[gangs] rep:", e.message);
    return false;
  }
}

// ── the cutover: import (idempotent, verifies itself, rolls back on any mismatch) ──
const backupDb = (tag) => require("./dbbackup").backupDb(tag);
let supplyFn = null;

function cleanExport(text) {
  let x;
  try { x = JSON.parse(text); } catch (e) { throw new Refuse(400, "payload is not JSON", "E_PAYLOAD"); }
  if (!x || typeof x !== "object" || !x.gangs || typeof x.gangs !== "object" || !x.members || typeof x.members !== "object") {
    throw new Refuse(400, "payload has no gangs / members", "E_PAYLOAD");
  }
  const users = x.users && typeof x.users === "object" ? x.users : {};
  const tags = new Set(), names = new Set();
  const gangs = [];
  for (const [gid, g] of Object.entries(x.gangs)) {
    if (!GID_RE.test(gid) || !g || typeof g !== "object") throw new Refuse(400, `bad gang ${String(gid).slice(0, 20)}`, "E_PAYLOAD");
    const tre = Number(g.treasury || 0), rep = Number(g.rep || 0);
    if (!Number.isSafeInteger(tre) || tre < 0 || !Number.isSafeInteger(rep) || rep < 0) throw new Refuse(400, `gang ${gid}: bad treasury / rep`, "E_PAYLOAD");
    if (g.wd_pending && Object.keys(g.wd_pending).length) throw new Refuse(409, `gang ${gid} still has withdrawals being paid - let them finish`, "E_PENDING");
    const tag = String(g.tag || ""), name = String(g.name || "");
    if (!tag || !name || tags.has(tag.toUpperCase()) || names.has(name.toLowerCase())) throw new Refuse(400, `gang ${gid}: duplicate or empty tag / name`, "E_PAYLOAD");
    tags.add(tag.toUpperCase()); names.add(name.toLowerCase());
    const members = (Array.isArray(g.members) ? g.members : []).map(low);
    if (!members.length || new Set(members).size !== members.length) throw new Refuse(400, `gang ${gid}: bad member list`, "E_PAYLOAD");
    const boss = low(g.boss);
    if (!members.includes(boss)) throw new Refuse(400, `gang ${gid}: the boss isn't a member`, "E_PAYLOAD");
    for (const mk of members) {
      if (!MKEY_RE.test(mk)) throw new Refuse(400, `gang ${gid}: bad member key`, "E_PAYLOAD");
      if (low(x.members[mk]) !== gid.toLowerCase() && x.members[mk] !== gid) throw new Refuse(400, `member ${mk} is listed in ${gid} but mapped to ${x.members[mk]}`, "E_PAYLOAD");
      if (!users[mk] || !users[mk].userId) throw new Refuse(400, `member ${mk} has no PATV account in the export`, "E_IDENTITY");
    }
    const officers = new Set((g.officers || []).map(low)), recruits = new Set((g.recruits || []).map(low));
    const extra = {};
    for (const [k, v] of Object.entries(g)) if (!KNOWN.has(k) && !NO_EXTRA.has(k)) extra[k] = v;
    gangs.push({ gid, g, tre, rep, tag, name, boss, members, officers, recruits, extra });
  }
  for (const [mk, gid] of Object.entries(x.members)) {
    const gg = gangs.find((z) => z.gid === gid);
    if (!gg || !gg.members.includes(low(mk))) throw new Refuse(400, `member ${mk} maps to ${gid}, which doesn't list them`, "E_PAYLOAD");
  }
  return { x, gangs, users };
}

/**
 * Pepe's export -> the tables, once. body: {key, payload (JSON text), digest (sha256 of payload), totals: {gangs, members,
 * treasury, rep}}. Checks: switch on, the pools live here, digest, totals, every member's account exists. Then a verified
 * DB backup and ONE transaction: Pepe's supply "gangs" row refreshed, the supply total read, the gangs / members / treasury
 * rows written, the casino's unacked rep queue applied (the keys Pepe already applied are only acked), everything re-read
 * and compared, the supply total read again (it must not move by one PAT), live on. Any mismatch -> ROLLBACK -> ok:false.
 */
async function importFromPepe(body) {
  await init();
  if (!(await enabled())) throw new Refuse(409, "the gangs backend is switched off on this site", "E_FEATURE_OFF");
  const key = checkKey(body && body.key);
  const payload = String((body && body.payload) || "");
  const digest = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
  if (!payload || digest !== String(body.digest || "")) throw new Refuse(400, "digest mismatch", "E_DIGEST");
  const done = await meta("imported");
  if (done && done.key === key && !done.rolled_back) {
    if (done.digest === digest) return Object.assign({ ok: true, already: true }, done.answer || {});
    throw new Refuse(409, "this cutover key was already used with a different export", "E_ALREADY");
  }
  if (await live()) throw new Refuse(409, "the site already owns the gangs (another import)", "E_ALREADY");
  if (!(await P().live())) throw new Refuse(409, "the pools still live in Pepe - the gang cutover comes after the pools cutover", "E_POOLS_LOCAL");
  const { x, gangs, users } = cleanExport(payload);
  const exp = { gangs: gangs.length, members: Object.keys(x.members).length, treasury: gangs.reduce((t, g) => t + g.tre, 0), rep: gangs.reduce((t, g) => t + g.rep, 0) };
  const tt = (body && body.totals) || {};
  for (const k of ["gangs", "members", "treasury", "rep"]) {
    if (Math.trunc(Number(tt[k])) !== exp[k]) throw new Refuse(400, `totals don't match: ${k} ${exp[k]} in the export vs ${tt[k]}`, "E_TOTALS");
  }
  // 1.99tc: every member's account - the exported userId followed through merges, else the username (an old renamed /
  // merged one via the username history, refused when ambiguous), else the member's Camfrog login. The resolved id is
  // what gets written (an export made before a merge still lands on the surviving account).
  const UN = require("./usernames");
  const missing = [], ambiguous = [], moved = [];
  for (const mk of Object.keys(users)) {
    const u = users[mk] || {};
    const r = await UN.resolveRecord({ userId: u.userId, username: u.username, login: mk }, { strict: true });
    if (!r.ok) { (r.code === UN.E_AMBIGUOUS ? ambiguous : missing).push(r.code === UN.E_AMBIGUOUS ? `${mk}: ${r.error}` : `${mk} (${u.userId || u.username || "?"})`); continue; }
    if (String(r.user.userId) !== String(u.userId)) moved.push(`${mk}: ${u.userId || "?"} -> ${r.user.userId} (${r.via})`);
    users[mk] = Object.assign({}, u, { userId: r.user.userId, username: r.user.username });
  }
  if (ambiguous.length) throw new Refuse(409, `${ambiguous.length} member account(s) are ambiguous (${ambiguous.slice(0, 3).join("; ")})`, "E_AMBIGUOUS");
  if (missing.length) throw new Refuse(409, `${missing.length} member account(s) don't exist here (${missing.slice(0, 3).join(", ")})`, "E_IDENTITY");
  if (moved.length) console.log(`[gangs] import: ${moved.length} member account(s) resolved past a merge / rename: ${moved.slice(0, 20).join(", ")}`);
  const heldGangPools = await getQuery("SELECT key, balance FROM pools WHERE key LIKE 'gang:%' AND balance != 0");
  if (heldGangPools.length) throw new Refuse(409, "gang treasuries already hold PAT here", "E_NOT_EMPTY");
  const backup = await backupDb("pre-gangs-import");
  let answer;
  try {
    answer = await tx(async () => {
      if (await meta("live")) throw new Refuse(409, "already imported", "E_ALREADY");
      // a previous (rolled back) copy of the tables: Pepe's export is the truth now
      for (const t of ["gang_members", "gang_invites", "gangs", "gangs_disbanded"]) await runQuery(`DELETE FROM ${t}`);
      await runQuery("DELETE FROM pools WHERE key LIKE 'gang:%' AND balance = 0");
      let before = null;
      if (supplyFn) {
        if (Number.isSafeInteger(Number(x.supply_gangs))) {
          const snap = (await getQuery("SELECT pools FROM supply_snapshot WHERE id = 1"))[0];
          const rows = parse(snap && snap.pools, []).filter((r) => String(r.key) !== "gangs");
          if (Number(x.supply_gangs) > 0) rows.push({ key: "gangs", label: "🎩 Gang treasuries", amount: Number(x.supply_gangs) });
          await runQuery("INSERT INTO supply_snapshot (id, pools, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET pools = excluded.pools, updated_at = CURRENT_TIMESTAMP",
                         [J(rows)]);
        }
        before = (await supplyFn()).total;
      }
      const t = now();
      const legs = [];
      for (const z of gangs) {
        const g = z.g;
        const wars = g.wars && typeof g.wars === "object" ? g.wars : null;
        await runQuery(`INSERT INTO gangs (gid, name, tag, boss, rep, heat, wars_w, wars_l, has_wars, unpaid_days, upgrades, rank_limits, withdraw_date,
                        withdrawn, created, extra, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                       [z.gid, z.name, z.tag, z.boss, z.rep, g.heat == null ? null : Math.trunc(Number(g.heat) || 0),
                        wars ? Math.trunc(Number(wars.wins) || 0) : 0, wars ? Math.trunc(Number(wars.losses) || 0) : 0, wars ? 1 : 0,
                        g.unpaid_days == null ? null : Math.trunc(Number(g.unpaid_days) || 0), g.upgrades == null ? null : J(g.upgrades),
                        g.rank_limits == null ? null : J(g.rank_limits), g.withdraw_date == null ? null : String(g.withdraw_date),
                        g.withdrawn == null ? null : J(g.withdrawn), g.created == null ? null : String(g.created), J(z.extra), t]);
        for (let i = 0; i < z.members.length; i++) {
          const mk = z.members[i];
          const rank = mk === z.boss ? "owner" : z.officers.has(mk) ? "officer" : z.recruits.has(mk) ? "recruit" : "member";
          await runQuery("INSERT INTO gang_members (member_key, gid, rank, userId, seq, joined) VALUES (?, ?, ?, ?, ?, ?)",
                         [mk, z.gid, rank, String(users[mk].userId), i, t]);
        }
        await runQuery(`INSERT INTO pools (key, label, balance, updated) VALUES (?, ?, ?, ?)
                        ON CONFLICT(key) DO UPDATE SET label = excluded.label, balance = excluded.balance, updated = excluded.updated`,
                       [poolKey(z.gid), `🎩 [${z.tag}] treasury`, z.tre, t]);
        if (z.tre) legs.push({ pool: poolKey(z.gid), amount: z.tre });
      }
      const mk = "import:gangs:" + key;
      for (let i = 0; i < legs.length; i++) {
        await runQuery("INSERT INTO pool_move_legs (move_key, i, pool, amount, after, ts) VALUES (?, ?, ?, ?, ?, ?)", [mk, i, legs[i].pool, legs[i].amount, legs[i].amount, t]);
      }
      for (const [gid, rec] of Object.entries(x.disbanded && typeof x.disbanded === "object" ? x.disbanded : {})) {
        if (GID_RE.test(gid) && rec && typeof rec === "object") await runQuery("INSERT OR REPLACE INTO gangs_disbanded (gid, data, ts) VALUES (?, ?, ?)", [gid, J(rec), (Number(rec.ts) || 0) * 1000]);
      }
      // the casino's gang-rep queue retires here: what Pepe already applied (in the exported rep) is only acked; the rest is
      // applied to the imported gangs, once per key
      await setMeta("live", true);
      forgetLive();
      const applied = new Set((Array.isArray(x.casino_rep_done) ? x.casino_rep_done : []).map(String));
      let repLeft = { applied: 0, acked: 0, rep: 0 };
      try {
        await require("./casino/rewards").ensure();
        const q = await getQuery("SELECT key, userId, camfrog, amount FROM casino_rep_queue WHERE acked IS NULL ORDER BY created, key");
        const todo = q.filter((r) => !applied.has(String(r.key)));
        if (todo.length) {
          const r = await applyRepInTx(todo.map((r) => ({ key: "casino:" + r.key, userId: r.userId, camfrog: r.camfrog, amount: r.amount, src: "casino" })));
          repLeft = { applied: r.applied, acked: q.length, rep: r.rep };
        } else repLeft.acked = q.length;
        if (q.length) await runQuery("UPDATE casino_rep_queue SET acked = ? WHERE acked IS NULL", [t]);
      } catch (e) {
        if (e instanceof Refuse) throw e;
        if (!/no such table/.test(String(e.message))) throw e;
      }
      // verify every gang and the totals, as written
      const st = await stateAll();
      const got = totalsOf(st);
      for (const z of gangs) {
        const s = st.gangs[z.gid];
        if (!s || s.treasury !== z.tre || s.members.length !== z.members.length || s.boss !== z.boss || String(s.tag) !== z.tag) {
          throw new Refuse(500, `gang ${z.gid} reads back differently after the import`, "E_VERIFY");
        }
      }
      if (got.gangs !== exp.gangs || got.members !== exp.members || got.treasury !== exp.treasury || got.rep !== exp.rep + repLeft.rep) {
        throw new Refuse(500, `the totals read back as ${J(got)}, not ${J(exp)} (+${repLeft.rep} queued casino rep)`, "E_VERIFY");
      }
      let after = null;
      if (before !== null) {
        after = (await supplyFn()).total;
        if (after !== before) throw new Refuse(500, `the supply total moved: ${before} before, ${after} after`, "E_SUPPLY");
      }
      if (x.cfg && typeof x.cfg === "object") await setMeta("cfg", x.cfg);
      const out = { totals: got, expected: exp, digest: digestOf(st), per_gang: Object.fromEntries(Object.entries(st.gangs).map(([g, v]) => [g, { treasury: v.treasury, rep: v.rep, members: v.members.length }])),
                    casino_rep: repLeft, supply_before: before, supply_after: after, backup };
      await P()._recordMove(mk, { kind: "import", flow: "gangs-cutover", why: "gang treasuries moved from Pepe", via: "pepe", legs, net: exp.treasury, ts: t,
                                  result: Object.assign({ ok: true }, { totals: got, digest: out.digest }) });
      await setMeta("imported", { key, digest, at: t, answer: out, actor: str(body.actor, 40) });
      await bumpRev();
      return out;
    });
  } catch (e) {
    forgetLive();
    if (e instanceof Refuse) { e.message += " - rolled back, nothing kept"; throw e; }
    throw e;
  }
  forgetLive();
  console.log(`[gangs] imported ${exp.gangs} gang(s), ${exp.members} member(s), ${exp.treasury} PAT in treasuries from Pepe (key ${key}, backup ${backup})`);
  return Object.assign({ ok: true }, answer);
}
/** applyRep's body for a caller that already holds the transaction (the import). */
async function applyRepInTx(list) {
  const out = { applied: 0, rep: 0 };
  for (const ev of list) {
    if ((await getQuery("SELECT 1 FROM gang_rep_events WHERE key = ?", [ev.key])).length) continue;
    let m = ev.userId ? (await getQuery("SELECT * FROM gang_members WHERE userId = ? ORDER BY seq LIMIT 1", [String(ev.userId)]))[0] : null;
    if (!m && ev.camfrog) m = await memberRow(low(ev.camfrog));
    const amt = Math.trunc(Number(ev.amount) || 0);
    await runQuery("INSERT INTO gang_rep_events (key, gid, member_key, userId, amount, src, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
                   [ev.key, m ? m.gid : null, m ? m.member_key : str(low(ev.camfrog), 80), str(ev.userId, 64), amt, ev.src, now()]);
    if (m && amt > 0) { await runQuery("UPDATE gangs SET rep = rep + ? WHERE gid = ?", [amt, m.gid]); out.applied++; out.rep += amt; }
  }
  return out;
}

/** Read-only: everything in Pepe's shape + sha256 + totals (the runbook's before / after, the way back, v2 genesis). */
async function exportState() {
  const st = await stateAll();
  return Object.assign({ ok: true, live: await live(), enabled: await enabled(), rev: await rev(), imported: await meta("imported"),
                         totals: totalsOf(st), digest: digestOf(st), cfg: await cfg() }, st);
}

/**
 * Rollback (the reverse import): every treasury -> 0 in ONE keyed move, live off, in one transaction. The answer (the full
 * state in Pepe's gang_data.json shape, the treasuries as they were taken, + sha256 + totals) is what Pepe writes back.
 */
async function rollbackToPepe({ key, actor }) {
  await init();
  key = checkKey(key);
  const mk = "rollback:gangs:" + key;
  const prev = await P().settledMoveStatus(mk);   // PO-0b (c): committed rows, in order
  if (prev) return Object.assign({}, prev, { dup: true });
  if (!(await live())) throw new Refuse(409, "the gangs aren't live here", "E_NOT_LIVE");
  const backup = await backupDb("pre-gangs-rollback");
  const out = await tx(async () => {
    const dup = await P()._seen(mk);
    if (dup) return dup;
    const st = await stateAll();
    const legs = Object.keys(st.gangs).filter((g) => st.gangs[g].treasury > 0).sort().map((g) => ({ pool: poolKey(g), amount: -st.gangs[g].treasury }));
    const a = legs.length ? await P()._applyLegs(mk, legs, { kind: "rollback", flow: "rollback", why: "gangs back to Pepe", via: "pepe" }) : { after: {}, net: 0, ts: now() };
    const left = Number((await getQuery("SELECT COALESCE(SUM(balance),0) AS t FROM pools WHERE key LIKE 'gang:%'"))[0].t);
    if (left !== 0) throw new Refuse(500, `the treasuries still hold ${left} after the rollback`, "E_VERIFY");
    const res = Object.assign({ ok: true, key, totals: totalsOf(st), digest: digestOf(st), backup }, st);
    await P()._recordMove(mk, { kind: "rollback", flow: "rollback", why: "gangs back to Pepe", via: str(actor, 40) || "pepe", legs, net: a.net, ts: a.ts, result: res });
    await P()._bumpRev();
    await setMeta("live", false);
    const rb = (await meta("rollbacks")) || [];
    rb.push({ key, at: now(), treasury: res.totals.treasury, actor: str(actor, 40) });
    await setMeta("rollbacks", rb.slice(-20));
    const imp = await meta("imported");
    if (imp) await setMeta("imported", Object.assign({}, imp, { rolled_back: { key, at: now() } }));
    await bumpRev();
    return res;
  });
  forgetLive();
  console.log(`[gangs] ROLLBACK ${key}: ${out.totals.gangs} gang(s), ${out.totals.treasury} PAT in treasuries handed back to Pepe (backup ${backup})`);
  return out;
}

// ── supply: the treasuries (patSupply in index.js) ──
async function supplyRows(rows) {
  if (!(await live())) return rows;
  const keep = (rows || []).filter((p) => String(p.key || "") !== "gangs");
  const t = Number((await getQuery("SELECT COALESCE(SUM(balance),0) AS t FROM pools WHERE key LIKE 'gang:%'"))[0].t) || 0;
  if (t > 0) keep.push({ key: "gangs", label: "🎩 Gang treasuries", amount: t });
  return keep;
}

// ── the web: pages + the management form ──
// The pages work in both modes: with the gangs live here they read the tables; before that (or after a rollback) they
// read the MIRROR Pepe pushes of his gang_data.json (/api/gangs/bot/mirror, display only - nothing on the site moves).
const UPGRADE_ICON = { recruiter: "📣", warchest: "💰", armory: "🔫", lookouts: "🔭", bribes: "🤝" };
const RANK_ORDER = { owner: 0, officer: 1, member: 2, recruit: 3 };
const BOARD_AVATARS = 8;

async function mirrorState() {
  const m = await meta("mirror");
  return m && m.gangs && typeof m.gangs === "object" ? m : null;
}
/** Pepe's gang_data.json (display copy) -> what the pages read. */
async function putMirror(b) {
  const gangs = b && b.gangs && typeof b.gangs === "object" ? b.gangs : null;
  if (!gangs) throw new Refuse(400, "gangs required");
  const clean = {};
  for (const [gid, g] of Object.entries(gangs).slice(0, 500)) {
    if (!GID_RE.test(gid) || !g || typeof g !== "object") continue;
    const x = {};
    for (const k of ["name", "tag", "boss", "officers", "members", "recruits", "treasury", "rep", "heat", "wars", "upgrades", "created",
                     "unpaid_days", "rank_limits"]) {
      if (g[k] !== undefined) x[k] = g[k];
    }
    clean[gid] = x;
  }
  const text = J({ gangs: clean, ts: now() });
  if (text.length > 2000000) throw new Refuse(400, "mirror too large");
  await setMeta("mirror", JSON.parse(text));
  return { ok: true, gangs: Object.keys(clean).length };
}
/** Every gang in Pepe's shape + where it came from: "site" (live) | "mirror" | null (nothing yet). */
async function sourceState() {
  if (await live()) return { mode: "site", st: await stateAll() };
  const m = await mirrorState();
  return m ? { mode: "mirror", st: { gangs: m.gangs }, ts: m.ts } : { mode: null, st: { gangs: {} } };
}
/** A gang's members with their rank: the boss, the officers, then the rest (by rep earned for the gang, then roster order). */
async function rosterOf(gid, g, mode) {
  const officers = new Set((g.officers || []).map(low)), recruits = new Set((g.recruits || []).map(low));
  const boss = low(g.boss);
  const contrib = {};
  if (mode === "site") {
    for (const r of await getQuery("SELECT member_key, SUM(amount) AS n FROM gang_rep_events WHERE gid = ? GROUP BY member_key", [gid])) contrib[r.member_key] = Number(r.n) || 0;
  }
  const list = (g.members || []).map((k, i) => {
    const key = low(k);
    const rank = key === boss ? "owner" : officers.has(key) ? "officer" : recruits.has(key) ? "recruit" : "member";
    return { key, rank, seq: i, contrib: contrib[key] || 0 };
  });
  list.sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank] || b.contrib - a.contrib || a.seq - b.seq);
  return list;
}
function keySeed(key) {
  const h = crypto.createHash("sha256").update(String(key)).digest();
  return (h.readUInt32BE(0) % 2147483646) + 1;
}
/** Display name, account and heist avatar (the GTF sheet's seed + the equipped GTF cosmetics) per member key. */
async function peopleFor(keys, mode) {
  const out = {};
  const ks = [...new Set(keys.map(low))].slice(0, 800);
  if (!ks.length) return out;
  const q = ks.map(() => "?").join(",");
  const byKey = {};
  if (mode === "site") {
    for (const r of await getQuery(`SELECT gm.member_key AS k, u.userId, u.username, u.displayname, u.camfrogUsername FROM gang_members gm
                                    LEFT JOIN users u ON u.userId = gm.userId WHERE gm.member_key IN (${q})`, ks)) byKey[r.k] = r;
  }
  for (const r of await getQuery(`SELECT userId, username, displayname, camfrogUsername, LOWER(camfrogUsername) AS k FROM users
                                  WHERE LOWER(camfrogUsername) IN (${q})`, ks)) if (!byKey[r.k] || !byKey[r.k].userId) byKey[r.k] = r;
  const seeds = {};
  try {
    for (const r of await getQuery(`SELECT camfrog, seed FROM cosmetic_avatar_seeds WHERE camfrog IN (${q})`, ks)) seeds[r.camfrog] = Number(r.seed) || null;
  } catch (e) { /* no seeds table yet */ }
  const cos = (() => { try { return require("./cosmetics"); } catch (e) { return null; } })();
  await Promise.all(ks.map(async (k) => {
    const u = byKey[k] || {};
    if (!seeds[k] && u.camfrogUsername && low(u.camfrogUsername) !== k) {
      const r = (await getQuery("SELECT seed FROM cosmetic_avatar_seeds WHERE camfrog = LOWER(?)", [u.camfrogUsername]).catch(() => []))[0];
      if (r && r.seed) seeds[k] = Number(r.seed);
    }
    const layers = {};
    if (cos && u.userId) {
      try {
        const eq = await cos.equippedFor(u.userId);
        for (const [kind, x] of Object.entries(eq || {})) {
          if (/^gtf_/.test(kind) && x && x.r && x.r.layer) layers[kind.slice(4)] = x.r.layer;
        }
      } catch (e) { /* cosmetics not ready */ }
    }
    out[k] = { name: u.camfrogUsername || u.displayname || u.username || k, username: u.username || null,
               seed: seeds[k] || keySeed(k), sheet: !!seeds[k], layers };
  }));
  return out;
}
function upgradeList(ups, c) {
  return Object.entries(c.upgrades || {}).map(([k, u]) => {
    const lvl = Number((ups || {})[k]) || 0;
    return { key: k, name: u.name, icon: UPGRADE_ICON[k] || "🛠️", lvl, max: u.max, desc: u.desc, next: lvl < u.max ? u.cost * (lvl + 1) : null };
  });
}

async function boardView(viewerId) {
  const c = await cfg();
  const src = await sourceState();
  const isLive = src.mode === "site";
  const entries = Object.entries(src.st.gangs || {});
  const rosters = {};
  const show = [];
  for (const [gid, g] of entries) {
    rosters[gid] = await rosterOf(gid, g, src.mode);
    for (const m of rosters[gid].slice(0, BOARD_AVATARS)) show.push(m.key);
  }
  const people = await peopleFor(show, src.mode);
  const list = entries.map(([gid, g]) => ({
    gid, tag: g.tag, name: g.name, level: level(g, c), rep: Number(g.rep) || 0, members: (g.members || []).length,
    cap: memberCap({ rep: g.rep, upgrades: J(g.upgrades || {}) }, c), treasury: Number(g.treasury) || 0,
    wars: g.wars || { wins: 0, losses: 0 }, heat: Number(g.heat) || 0, upgrades: upgradeList(g.upgrades, c).filter((u) => u.lvl > 0),
    avatars: rosters[gid].slice(0, BOARD_AVATARS).map((m) => Object.assign({ key: m.key, rank: m.rank }, people[m.key])) }));
  list.sort((a, b) => b.rep - a.rep || String(a.tag).localeCompare(String(b.tag)));
  let mine = null;
  if (viewerId) {
    const me = isLive ? await webMember(viewerId) : null;
    if (me) mine = me.gid;
    else {
      const u = await userFor({ userId: viewerId });
      const k = u && u.camfrogUsername ? low(u.camfrogUsername) : null;
      if (k) for (const [gid, g] of entries) if ((g.members || []).map(low).includes(k)) mine = gid;
    }
  }
  return { live: isLive, mode: src.mode, mirror_ts: src.ts || null, gangs: list, cfg: c, mine, avatar_limit: BOARD_AVATARS };
}

async function gangView(tag, viewerId) {
  const c = await cfg();
  const src = await sourceState();
  const isLive = src.mode === "site";
  if (!src.mode) return { live: false, mode: null };
  const found = Object.entries(src.st.gangs || {}).find(([, x]) => String(x.tag || "").toLowerCase() === String(tag || "").toLowerCase());
  if (!found) return { live: isLive, mode: src.mode, gang: null };
  const [gid, s] = found;
  const row = isLive ? await gangRow(gid) : null;
  const roster = await rosterOf(gid, s, src.mode);
  const people = await peopleFor(roster.map((m) => m.key), src.mode);
  const lvl = level(s, c);
  const me = isLive && viewerId ? await webMember(viewerId) : null;
  const mine = me && me.gid === gid ? me : null;
  const today = todayFor(c);
  const taken = row && row.withdraw_date === today ? parse(row.withdrawn, {}) || {} : {};
  let inv = null;
  if (isLive && viewerId && !me) {
    const u = await userFor({ userId: viewerId });
    inv = u ? (await getQuery("SELECT gid FROM gang_invites WHERE member_key IN (?, ?)", [keyForUser(u), "u:" + u.userId]))[0] : null;
  }
  const history = isLive ? await getQuery(`SELECT key, op, actor_key, via, ts, result FROM gang_ops WHERE gid = ? AND op IN ('deposit','withdraw','spend','move','create')
                                            ORDER BY ts DESC LIMIT 15`, [gid]) : [];
  const hn = history.length ? await peopleFor(history.map((h) => h.actor_key).filter(Boolean), src.mode) : {};
  const limitsOf = (r) => rankLimit(row || { rank_limits: J(s.rank_limits || {}) }, r, c);
  return {
    live: isLive, mode: src.mode, mirror_ts: src.ts || null, cfg: c,
    gang: {
      gid, tag: s.tag, name: s.name, created: s.created || null, level: lvl, rep: Number(s.rep) || 0, next: lvl * c.rep_per_level,
      prev: (lvl - 1) * c.rep_per_level, cap: memberCap({ rep: s.rep, upgrades: J(s.upgrades || {}) }, c), treasury: Number(s.treasury) || 0,
      heat: Number(s.heat) || 0, wars: s.wars || { wins: 0, losses: 0 }, unpaid_days: Number(s.unpaid_days) || 0, upgrades: s.upgrades || {},
      upgrade_list: upgradeList(s.upgrades, c),
      limits: Object.fromEntries(RANKS.map((r) => [r, limitsOf(r)])),
      members: roster.map((m) => Object.assign({ key: m.key, rank: m.rank, used: Number(taken[m.key]) || 0 }, people[m.key])),
      history: history.map((h) => {
        const r = parse(h.result, {});
        return { op: h.op, ts: h.ts, via: h.via, who: h.actor_key ? (hn[h.actor_key] || { name: h.actor_key }).name : null,
                 amount: r.amount || null, net: r.net || null, cut: r.cut || null };
      }),
    },
    me: mine ? { key: mine.member_key, rank: mine.rank, limit: rankLimit(row, mine.rank, c), used: Number(taken[mine.member_key]) || 0,
                 manage: mine.rank === "owner" || mine.rank === "officer", boss: mine.rank === "owner" } : null,
    invited: !!(inv && inv.gid === gid),
  };
}

/** A website action (the gang page's forms) -> {ok, msg} | throws Refuse. */
async function webAct(userId, body) {
  await requireLive();
  const u = await userFor({ userId });
  if (!u) throw new Refuse(401, "Sign in first.", "E_AUTH");
  const op = String((body && body.op) || "");
  const idem = /^[A-Za-z0-9_-]{8,64}$/.test(String(body.idem || "")) ? String(body.idem) : crypto.randomBytes(9).toString("hex");
  const key = `web:${userId}:${op}:${idem}`.slice(0, 160);
  const me = await webMember(userId);
  const myKey = me ? me.member_key : keyForUser(u);
  const targetKey = async () => {
    const raw = String(body.target || "").trim().replace(/^@+/, "");
    if (!raw) throw new Refuse(400, "Who?", "E_TARGET");
    const inGang = await memberRow(low(raw));
    if (inGang) return inGang.member_key;
    const t = (await getQuery("SELECT userId, username, camfrogUsername FROM users WHERE LOWER(camfrogUsername) = LOWER(?) OR LOWER(username) = LOWER(?) LIMIT 1", [raw, raw]))[0];
    if (!t) throw new Refuse(404, `No PATV account or Camfrog name "${raw.slice(0, 40)}".`, "E_TARGET");
    const byUser = (await getQuery("SELECT member_key FROM gang_members WHERE userId = ? LIMIT 1", [t.userId]))[0];
    return byUser ? byUser.member_key : keyForUser(t);
  };
  if (op === "deposit") {
    const r = await deposit({ key, member: myKey, userId, amount: Math.trunc(Number(body.amount) || 0) }, "web");
    return { ok: true, msg: r.dup ? "Already done." : `Banked ${fmt(r.amount)} PAT - treasury now ${fmt(r.treasury)} PAT.`, r };
  }
  if (op === "withdraw") {
    const r = await withdraw({ key, member: myKey, userId, amount: Math.trunc(Number(body.amount) || 0) }, "web");
    return { ok: true, msg: r.dup ? "Already done." : `Withdrew ${fmt(r.amount)} PAT: ${fmt(r.net)} to your wallet` + (r.cut ? `, ${fmt(r.cut)} laundering fee to Fort Knox.` : "."), r };
  }
  if (op === "invite") { const r = await invite({ key, actor: myKey, target: await targetKey() }, "web"); return { ok: true, msg: `Invited. They can accept here or with !gang accept.`, r }; }
  if (op === "accept") {
    const r = await accept({ key, member: myKey, userId, gid: body.gid }, "web");
    return { ok: true, msg: `You're in - ${r.strength} strong.`, r };
  }
  if (op === "decline") { await decline({ member: myKey }); return { ok: true, msg: "Invite declined." }; }
  if (op === "leave") { const r = await leaveLike({ key, member: myKey }, "web", "leave"); return { ok: true, msg: "You left the gang.", r }; }
  if (op === "kick") { const r = await kick({ key, actor: myKey, target: await targetKey() }, "web"); return { ok: true, msg: "Kicked.", r }; }
  if (op === "promote" || op === "demote") {
    const r = await role({ key, actor: myKey, target: await targetKey(), promote: op === "promote" }, "web");
    return { ok: true, msg: op === "promote" ? "Promoted to officer." : "Demoted to member.", r };
  }
  if (op === "limits") {
    const r = await limits({ key, actor: myKey, rank: body.rank, amount: Math.trunc(Number(body.amount) || 0) }, "web");
    return { ok: true, msg: `${r.rank}s can now withdraw ` + (r.amount ? `${fmt(r.amount)} PAT/day.` : "with no daily cap."), r };
  }
  throw new Refuse(400, "Unknown action.", "E_OP");
}

// ── routes ──
function register(app, { isBotToken, addUser, patSupply }) {
  if (patSupply) supplyFn = patSupply;
  init().catch((e) => console.error("[gangs] init:", e.message));
  const send = (res, e, tag) => {
    if (e instanceof Refuse) return res.status(e.status).json(Object.assign({ ok: false, error: e.message, code: e.code }, e.extra || {}));
    if (e instanceof P().Refuse) return res.status(e.status).json(Object.assign({ ok: false, error: e.message, code: e.code }, e.extra || {}));
    console.error(`[gangs] ${tag}:`, e);
    res.status(500).json({ ok: false, error: "server_error" });
  };
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) { send(res, e, "bot"); }
  };
  const OPS = {
    create: (b) => create(b, "chat"), invite: (b) => invite(b, "chat"), accept: (b) => accept(b, "chat"), decline: (b) => decline(b),
    leave: (b) => leaveLike(b, "chat", "leave"), defect: (b) => leaveLike(b, "chat", "defect"), kick: (b) => kick(b, "chat"),
    promote: (b) => role(Object.assign({}, b, { promote: true }), "chat"), demote: (b) => role(Object.assign({}, b, { promote: false }), "chat"),
    boss: (b) => setBoss(b, "chat"), tag: (b) => setTag(b, "chat"), limits: (b) => limits(b, "chat"), deposit: (b) => deposit(b, "chat"),
    withdraw: (b) => withdraw(b, "chat"), spend: (b) => spend(b, "pepe"), move: (b) => move(b, "pepe"), disband: (b) => disband(b, "chat"),
    patch: (b) => patch(b, "pepe"),
  };
  app.post("/api/gangs/bot/state", bot(async (b) => {
    const r = await rev();
    if (b.since_rev !== undefined && Number(b.since_rev) === r) return { ok: true, live: await live(), enabled: await enabled(), rev: r, same: true };
    return Object.assign({ ok: true, live: await live(), enabled: await enabled(), rev: r }, (await live()) ? await stateAll() : {});
  }));
  app.post("/api/gangs/bot/op", bot((b) => {
    const fn = OPS[String(b.op || "")];
    if (!fn) throw new Refuse(400, "unknown op", "E_OP");
    return fn(b);
  }));
  app.post("/api/gangs/bot/op-status", bot(async (b) => ({ ok: true, result: await settledOpStatus(b.key) })));   // PO-0b: committed, in order
  app.post("/api/gangs/bot/rep", bot(async (b) => Object.assign({ ok: true }, await applyRep(b.events))));
  app.post("/api/gangs/bot/mirror", bot((b) => putMirror(b)));      // the pages' display copy while the gangs live in Pepe
  app.post("/api/gangs/bot/config", bot(async (b) => {
    if (!b.cfg || typeof b.cfg !== "object") throw new Refuse(400, "cfg required");
    const s = J(b.cfg);
    if (s.length > 20000) throw new Refuse(400, "cfg too large");
    await setMeta("cfg", b.cfg);
    return { ok: true };
  }));
  // 1.99sy: the gangs export can exceed the global 100 KB JSON limit (index.js skips this path)
  app.post("/api/gangs/admin/import", require("express").json({ limit: "32mb" }), bot((b) => importFromPepe(b)));
  app.post("/api/gangs/admin/export", bot(() => exportState()));
  app.post("/api/gangs/admin/rollback", bot((b) => rollbackToPepe({ key: b.key, actor: b.actor })));

  // the website
  const uid = (req) => (req.user && req.user.userId) || null;
  app.get("/api/gangs", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json(Object.assign({ ok: true }, await boardView(uid(req)))); } catch (e) { send(res, e, "board"); }
  });
  app.get("/api/gangs/:tag", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json(Object.assign({ ok: true }, await gangView(req.params.tag, uid(req)))); } catch (e) { send(res, e, "gang"); }
  });
  app.post("/api/gangs/act", addUser, async (req, res) => {
    if (!uid(req)) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    try { res.json(await webAct(uid(req), req.body || {})); } catch (e) { send(res, e, "act"); }
  });
  app.get("/gtf/gangs", addUser, async (req, res) => {
    try {
      res.render("gangs", { user: req.user ? req.user.username : null, view: await boardView(uid(req)) });
    } catch (e) { console.error("[gangs] page:", e); res.status(500).send("Something went wrong."); }
  });
  app.get("/gtf/gangs/:tag", addUser, async (req, res) => {
    try {
      const v = await gangView(req.params.tag, uid(req));
      if (v.live && !v.gang) return res.status(404).render("gang", { user: req.user ? req.user.username : null, v, signedIn: !!uid(req) });
      res.render("gang", { user: req.user ? req.user.username : null, v, signedIn: !!uid(req) });
    } catch (e) { console.error("[gangs] page:", e); res.status(500).send("Something went wrong."); }
  });

  // admins: the switch (before the import) and a read-only view
  const admin = async (req, res) => {
    if (!uid(req)) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const row = (await getQuery("SELECT class, username FROM users WHERE userId = ?", [uid(req)]).catch(() => []))[0];
    if (!SP.can(row, "econ.backend_cutover")) { res.status(403).json({ ok: false, error: "Admins only." }); return null; }
    return row;
  };
  app.get("/api/admin/gangs", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!(await admin(req, res))) return;
    try {
      const st = await exportState();
      st.ops = await getQuery("SELECT key, gid, op, actor_key, via, ts FROM gang_ops ORDER BY ts DESC LIMIT 60");
      st.rollbacks = (await meta("rollbacks")) || [];
      res.json(st);
    } catch (e) { send(res, e, "admin"); }
  });
  app.post("/api/admin/gangs-backend", addUser, async (req, res) => {
    const me = await admin(req, res);
    if (!me) return;
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    // PO-0b (D-6): a backend switch is a Pepe OWNER's (class + the owner role on the linked chat login, read fresh); the VPS CLI
    // (tools/*-backend.js) stays the emergency path
    {
      const SR = require("./staffroles");
      if (!(await SR.ownerOf({ userId: uid(req) }, "econ.backend_cutover"))) return res.status(403).json({ ok: false, code: "owner_only", error: SR.OWNER_ONLY });
    }
    if (await live()) return res.status(409).json({ ok: false, error: "The site owns the gangs now - roll back from Pepe (docs/gangs-cutover-runbook.md)." });
    await setMeta("enabled", !!(req.body || {}).on);
    console.log(`[gangs] backend switch ${(req.body || {}).on ? "ON" : "OFF"} by ${me.username}`);
    res.json({ ok: true, enabled: await enabled() });
  });
}

module.exports = { init, register, enabled, live, rev, cfg, stateAll, totalsOf, digestOf, create, invite, accept, decline, leaveLike, kick, role,
                   setBoss, setTag, limits, deposit, withdraw, spend, move, disband, patch, applyRep, addRep, importFromPepe, exportState,
                   rollbackToPepe, supplyRows, boardView, gangView, putMirror, webAct, opStatus, settledOpStatus, splitShares, Refuse, DEFAULT_CFG,
                   _setSupplyFn: (f) => { supplyFn = f; }, _forgetLive: forgetLive, _setMeta: setMeta };
