// roomvaults.js — economy v2 E-3: ROOM VAULTS on the site (camfrog-bot docs/ECONOMY-V2.md 6.4, 7, 12; Pepe's
// pepe_roomvault.py, flag econ_room_vaults). Accumulate only: nothing pays out of a room vault here.
//
// The vaults live in Pepe (room:<room id> pools); the site shows them. Pepe posts his state every few minutes and
// right after a change:
//   POST /api/g/roomvaults/sync  (bot token) {on, cap, deposit_min, rate: {default, min, max}, total,
//                                 rooms: [{id, balance, days: {yyyy-mm-dd: {in, dep, mig, out, ovf}}, history: [...]}]}
//     -> {ok, settings: {room id: {rate, changed_at, changed_by}}}   (the owner's payout rate, stored for E-4)
//   GET  /api/rooms/:slug/vault       the pad page card's data (public)
//   POST /api/rooms/:slug/vault/rate  {rate}  the pad's owner (or site staff): the daily payout rate, 2-15%,
//                                     at most one change per 7 days (staff are not limited). STORED ONLY: Pepe's E-4
//                                     recipe will use it; nothing pays out yet.
//   POST /api/rooms/:slug/vault/donate {amount, idem, anon}  1.99sn: the pad page's public "Donate to this pad's vault" -
//                                     ANY signed-in account (not just the owner): the same keyed website action as the
//                                     owner panel's top-up ("roomvault.deposit" = Pepe's !padvault deposit: escrow hold ->
//                                     settle, min, never past the cap). A donation is a DEPOSIT: never inflow, so it never
//                                     raises the owner-share cap or a gang's bond. No Camfrog name linked = Pepe charges the
//                                     PATV account itself. `anon` keeps the donor's name off the public list.
//
// EVERY PAD HAS A VAULT (1.99uu, the user 2026-10-12: "earning does not need Plus"): a pad connected to a chat room or not
// (Camfrog, site-only, Twitch, Discord) - hasVault() / boosts.vaultEligible(). A profile pad only while profile vaults are on.
// Its row here appears with Pepe's first sync that lists it (an empty vault has no row: card() answers 0 - lazily), or
// with tools/padvault-rows.js (an idempotent backfill of empty rows; supply unchanged).
//
// "Pad vault" is the name users see (1.99sn); the code, tables and Pepe's pool keys keep "room vault" / room:<id>.
//
// E-4 (Pepe's pepe_recipe.py, flag econ_room_payouts): each room's sync row may carry `recipe` {epochs: the last 7 payout
// days - budget B, what each slice paid (owner / gang / streamers / regulars), the room-games allowance, what stayed,
// the owner's presence and the room's active days, the cap; never names}, and the body `recipe` {on, topup, frozen, cfg}.
// Stored in room_vault_state.recipe / room_vault_meta.recipe for the pad card and the owner panel's Owner share card.
//
// PROFILE VAULTS (2026-10-12, the user; Pepe's pepe_padtopup.py, flag econ_profile_vaults): a profile pad (user:<id>) has a
// vault too once Pepe reports `profile_vaults` on the sync. It is filled by others' spending on that profile (PATV Creators'
// platform cut for the creator's own profile - creators.js routeCutInTx - boosts and other profile-scoped room flows,
// donations) and by the activity top-up pool, and pays out through the recipe (the owner's share from their posts'
// engagement, capped at 25% of organic inflow, self-spend excluded; the participants' share to the people who engaged).
// profileVaultsOn() is the cached switch (boosts.vaultEligible, creators.js, the profile page's card).
//
// "Inflow" is what the room's own activity routed in (Pepe's room flows + the website's room halves). Deposits and the
// one-time escrow migration are shown on their own and NEVER count as inflow (doc 6.4).
//
//   room_vault_state     room_id PK, balance, days (JSON, Pepe's last 8 days), history (JSON, latest moves), updated,
//                        recipe (E-4), donors (1.99sn: JSON, the latest deposits - {ts, amount, who} or {ts, amount, anon})
//   room_vault_meta      key/value: on, cap, total, synced (Pepe's last sync), deposit_min, rate bounds
//   room_vault_settings  room_id PK, rate, changed_at (ms), changed_by (userId)
//   room_vault_rate_log  room_id, rate, prev, by (userId), at - the audit trail of rate changes
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const RATE = Object.freeze({ default: 10, min: 2, max: 15 });
const RATE_EVERY_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
let clock = () => Date.now();
const now = () => clock();
let PROFILE_ON = false;          // Pepe's last sync: profile pads have vaults (econ_profile_vaults)
/** Profile pads (user:<id>) have vaults now (Pepe's switch, cached from his last sync). */
const profileVaultsOn = () => PROFILE_ON === true;

class Refuse extends Error {
  constructor(status, message) { super(message); this.status = status; this.refuse = true; }
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS room_vault_state (room_id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0,
        days TEXT, history TEXT, updated INTEGER)`);
      await runQuery("CREATE TABLE IF NOT EXISTS room_vault_meta (key TEXT PRIMARY KEY, value TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS room_vault_settings (room_id TEXT PRIMARY KEY, rate REAL NOT NULL,
        changed_at INTEGER, changed_by TEXT)`);
      await runQuery("CREATE TABLE IF NOT EXISTS room_vault_rate_log (room_id TEXT, rate REAL, prev REAL, by TEXT, at INTEGER)");
      const cols = (await getQuery("SELECT name FROM pragma_table_info('room_vault_state')")).map((c) => c.name);
      if (!cols.includes("recipe")) await runQuery("ALTER TABLE room_vault_state ADD COLUMN recipe TEXT");   // E-4
      if (!cols.includes("donors")) await runQuery("ALTER TABLE room_vault_state ADD COLUMN donors TEXT");   // 1.99sn
      try {
        const pv = (await getQuery("SELECT value FROM room_vault_meta WHERE key = 'profile_vaults'"))[0];
        PROFILE_ON = !!pv && JSON.parse(pv.value) === true;
      } catch (e) { PROFILE_ON = false; }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const int = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : 0; };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanDays(d) {
  const out = {};
  for (const [k, v] of Object.entries(d && typeof d === "object" ? d : {}).slice(0, 40)) {
    if (!DAY_RE.test(k) || !v || typeof v !== "object") continue;
    out[k] = { in: int(v.in), dep: int(v.dep), mig: int(v.mig), out: int(v.out), ovf: int(v.ovf), lp: int(v.lp),   // lp: launchpad grants + owner match
               top: int(v.top),                                                                                     // E-4: the room reward top-up
               adm: int(v.adm) };                                                                                   // 1.99yx: admin fines / transfers (signed; padfines.js)
  }
  return out;
}
const KINDS = ["flow", "site", "deposit", "migration", "refund", "challenge", "launch", "match", "recipe", "topup",   // launch / match: the launchpad; recipe / topup: E-4
               "fine", "xfer_out", "xfer_in"];                                                                     // 1.99yx: admin fines / transfers (padfines.js)
// 1.99sn: a deposit's public face, as Pepe reports it - a display name, or anon (the login never leaves Pepe then)
const cleanWho = (v) => String(v || "").replace(/[<>"&\u0000-\u001f]/g, "").trim().slice(0, 40);
function donorOf(e) {
  if (e && e.anon === true) return { anon: true };
  const w = cleanWho(e && e.who);
  return w ? { who: w } : {};
}
function cleanHistory(h) {
  return (Array.isArray(h) ? h : []).slice(0, 12).map((e) => {
    const o = {
      ts: int(e && e.ts), kind: KINDS.includes(e && e.kind) ? e.kind : "flow",
      flow: String((e && e.flow) || "").replace(/[^A-Za-z0-9 _:-]/g, "").slice(0, 32),
      amount: int(e && e.amount), overflow: int(e && e.overflow),
    };
    return o.kind === "deposit" ? Object.assign(o, donorOf(e)) : o;
  });
}
function cleanDonors(d) {
  if (!Array.isArray(d)) return null;          // an older Pepe sends none: keep what we had
  return d.slice(0, 8).map((e) => Object.assign({ ts: int(e && e.ts), amount: Math.max(0, int(e && e.amount)) }, donorOf(e)))
    .filter((e) => e.amount > 0);
}

// E-4: one payout day as Pepe reports it (numbers + short reasons only)
const EP_NUM = ["B", "balance", "owner", "gang", "streamers", "people", "people_n", "streamers_n", "games_allow", "games_used_prev",
                "paid", "stays", "cap", "i7", "owner_present", "active_days", "convoy", "topup", "topup_pool", "engagement"];
function cleanRecipe(r) {
  if (!r || typeof r !== "object") return null;
  const epochs = (Array.isArray(r.epochs) ? r.epochs : []).slice(-7).filter((e) => e && DAY_RE.test(String(e.day || ""))).map((e) => {
    const o = { day: e.day, rate: Math.round((Number(e.rate) || 0) * 100) / 100, house: !!e.house, vwm: Math.round((Number(e.vwm) || 0) * 10) / 10, why: {} };
    for (const k of EP_NUM) o[k] = Math.max(0, int(e[k]));
    o.basis = ["chat", "pad", "profile"].includes(e.basis) ? e.basis : null;     // 1.99uu: what the owner gate measured
    for (const k of ["owner", "gang", "streamers", "people"]) {
      if (e.why && typeof e.why[k] === "string") o.why[k] = e.why[k].replace(/[<>]/g, "").slice(0, 80);
    }
    return o;
  });
  const g = r.games && typeof r.games === "object" ? { day: DAY_RE.test(String(r.games.day || "")) ? r.games.day : null,
                                                        allow: Math.max(0, int(r.games.allow)), used: Math.max(0, int(r.games.used)) } : null;
  return { epochs, games: g };
}
function cleanRecipeMeta(m) {
  if (!m || typeof m !== "object") return null;
  const cfg = {};
  for (const [k, v] of Object.entries(m.cfg && typeof m.cfg === "object" ? m.cfg : {}).slice(0, 20)) {
    if (/^[a-z0-9_]{1,20}$/.test(k) && Number.isFinite(Number(v))) cfg[k] = Number(v);
  }
  // 2026-10-12: + the activity top-up pool (activity_pads: the "activity" budget funds the pad top-up; global activity
  // rewards off) and its last day's numbers, and whether profile pads have vaults
  const pool = m.pool && typeof m.pool === "object" ? { day: DAY_RE.test(String(m.pool.day || "")) ? m.pool.day : null, pool: Math.max(0, int(m.pool.pool)),
    paid: Math.max(0, int(m.pool.paid)), pads: Math.max(0, int(m.pool.pads)) } : null;
  return { on: m.on === true, topup: m.topup === true, frozen: m.frozen === true, cfg, activity_pads: m.activity_pads === true,
           profile_vaults: m.profile_vaults === true, activity_rewards: m.activity_rewards === true, pool };
}

async function metaGet() {
  await init();
  const m = {};
  for (const r of await getQuery("SELECT key, value FROM room_vault_meta")) { try { m[r.key] = JSON.parse(r.value); } catch (e) { /* skip */ } }
  return m;
}
async function metaSet(m) {
  for (const [k, v] of Object.entries(m)) {
    await runQuery("INSERT INTO room_vault_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, JSON.stringify(v)]);
  }
}

/** Pepe's state -> the tables (the whole set replaces the old one: a room Pepe no longer lists is at 0). */
async function sync(body) {
  await init();
  const b = body || {};
  const rooms = (Array.isArray(b.rooms) ? b.rooms : []).slice(0, 2000);
  const t = now();
  await require("./boosts").tx(async () => {
    await runQuery("UPDATE room_vault_state SET balance = 0, updated = ?", [t]);
    for (const r of rooms) {
      const id = String((r && r.id) || "").slice(0, 120);
      if (!id) continue;
      const rc = cleanRecipe(r.recipe);
      const dn = cleanDonors(r.donors);
      await runQuery(`INSERT INTO room_vault_state (room_id, balance, days, history, updated, recipe, donors) VALUES (?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(room_id) DO UPDATE SET balance = excluded.balance, days = excluded.days, history = excluded.history, updated = excluded.updated,
                      recipe = COALESCE(excluded.recipe, room_vault_state.recipe), donors = COALESCE(excluded.donors, room_vault_state.donors)`,
                     [id, Math.max(0, int(r.balance)), JSON.stringify(cleanDays(r.days)), JSON.stringify(cleanHistory(r.history)), t,
                      rc ? JSON.stringify(rc) : null, dn ? JSON.stringify(dn) : null]);
    }
    await metaSet({ on: b.on === true, cap: int(b.cap) || null, total: Math.max(0, int(b.total)), synced: t,
                    deposit_min: int(b.deposit_min) || null, profile_vaults: b.profile_vaults === true,
                    // 1.99uu: the recipe copy's profile_vaults is the sync's own flag when an older Pepe leaves it out (it
                    // read false on prod while profile vaults were on)
                    recipe: cleanRecipeMeta(b.recipe && typeof b.recipe === "object"
                      ? Object.assign({}, b.recipe, { profile_vaults: typeof b.recipe.profile_vaults === "boolean" ? b.recipe.profile_vaults : b.profile_vaults === true })
                      : b.recipe) });
    PROFILE_ON = b.profile_vaults === true;
  });
  return { settings: await settingsMap() };
}

async function settingsMap() {
  await init();
  const out = {};
  for (const r of await getQuery("SELECT room_id, rate, changed_at, changed_by FROM room_vault_settings")) {
    out[r.room_id] = { rate: Number(r.rate), changed_at: r.changed_at || null, changed_by: r.changed_by || null };
  }
  return out;
}

/** The pad page card. Days: Pepe's local days, the last 7 (today included). */
async function card(roomId, user, opts = {}) {
  await init();
  const id = String(roomId || "");
  const meta = await metaGet();
  const st = (await getQuery("SELECT balance, days, history, updated, recipe, donors FROM room_vault_state WHERE room_id = ?", [id]))[0] || null;
  const set = (await getQuery("SELECT rate, changed_at, changed_by FROM room_vault_settings WHERE room_id = ?", [id]))[0] || null;
  let days = {};
  let history = [];
  try { days = st && st.days ? JSON.parse(st.days) : {}; } catch (e) { days = {}; }
  try { history = st && st.history ? JSON.parse(st.history) : []; } catch (e) { history = []; }
  let recipe = null;
  try { recipe = st && st.recipe ? JSON.parse(st.recipe) : null; } catch (e) { recipe = null; }
  let donors = [];
  try { donors = st && st.donors ? JSON.parse(st.donors) : []; } catch (e) { donors = []; }
  const keys = Object.keys(days).sort().slice(-7);
  const sum = (f) => keys.reduce((s, k) => s + int((days[k] || {})[f]), 0);
  const t = now();
  const changedAt = set && set.changed_at ? Number(set.changed_at) : null;
  const nextChange = changedAt ? changedAt + RATE_EVERY_MS : null;
  const canSet = !!opts.canManage;
  const staff = !!opts.staff;
  const rmeta = meta.recipe || {};
  const epochs = (recipe && recipe.epochs) || [];
  // 1.99sn: the public card's "How it pays out" - the recipe's slices (Pepe's cfg, fractions; the E-4 defaults until synced)
  const pct = (k, d) => { const v = Number((rmeta.cfg || {})[k]); return Math.round((Number.isFinite(v) && v > 0 && v <= 1 ? v : d) * 100); };
  const split = { owner: pct("owner_pct", 0.15), gang: pct("gang_pct", 0.15), streamers: pct("streamer_pct", 0.25),
                  people: pct("people_pct", 0.35), games: pct("games_pct", 0.10) };
  const wsum = (f) => epochs.reduce((s, e) => s + int(e[f]), 0);
  const week = epochs.length ? { days: epochs.length, paid: wsum("paid"), stays: wsum("stays"), owner: wsum("owner"), gang: wsum("gang"),
                                 streamers: wsum("streamers"), people: wsum("people"), games: wsum("games_used_prev"),
                                 last: epochs[epochs.length - 1] } : null;
  let viewer = null;
  if (user && user.userId) {
    const u = (await getQuery("SELECT points_balance, camfrogUsername FROM users WHERE userId = ?", [user.userId]))[0] || {};
    viewer = { balance: Math.max(0, int(u.points_balance)), linked: !!u.camfrogUsername };
  }
  const isProf = require("./rooms").isProfile(id);
  return {
    profile: isProf,
    live: meta.on === true && (!isProf || profileVaultsOn()), synced: meta.synced || null, cap: meta.cap || 50000000, deposit_min: meta.deposit_min || 1000,
    balance: st ? int(st.balance) : 0,
    inflow7: sum("in"), deposits7: sum("dep"), migrated7: sum("mig"), paid7: sum("out"), overflow7: sum("ovf"), launch7: sum("lp"),
    days: keys.map((k) => ({ day: k, in: int(days[k].in), dep: int(days[k].dep), mig: int(days[k].mig), out: int(days[k].out), top: int(days[k].top) })),
    topup7: sum("top"),
    // E-4: the payout recipe (Pepe's last 7 payout days) and whether it's live
    recipe: { live: !!(meta.recipe && meta.recipe.on), topup: !!(meta.recipe && (meta.recipe.topup || meta.recipe.activity_pads)), frozen: !!(meta.recipe && meta.recipe.frozen),
              activity_pads: !!(meta.recipe && meta.recipe.activity_pads),
              cfg: (meta.recipe && meta.recipe.cfg) || {}, epochs: (recipe && recipe.epochs) || [], games: (recipe && recipe.games) || null },
    history: history.slice(0, 8),
    donors: (Array.isArray(donors) ? donors : []).slice(0, 8), split, week, viewer,
    rate: set ? Number(set.rate) : RATE.default, rate_default: !set, rate_changed: changedAt,
    rate_bounds: { min: RATE.min, max: RATE.max },
    can_set_rate: canSet, rate_locked_until: canSet && !staff && nextChange && nextChange > t ? nextChange : null,
  };
}

/** 1.99uu: every pad has a vault, connected to a chat room or not; a profile pad once Pepe's profile vaults are on. */
function hasVault(roomId) {
  const rooms = require("./rooms");
  if (!String(roomId || "")) return false;
  return rooms.platformOf(roomId) !== "profile" || profileVaultsOn();
}

/** The owner (or staff) sets the payout rate: 2-15%, whole or half percent, once per 7 days (staff: any time). */
async function setRate(roomId, user, rate) {
  await init();
  const rooms = require("./rooms");
  const R = await rooms.get(String(roomId || ""));
  if (!R) throw new Refuse(404, "No such pad.");
  if (!hasVault(R.id)) throw new Refuse(400, "This pad has no vault yet.");
  if (!(await rooms.canManage(user, R.id))) throw new Refuse(403, "Only the pad's owner can set its payout rate.");
  const r = Math.round(Number(rate) * 2) / 2;
  if (!Number.isFinite(r) || r < RATE.min || r > RATE.max) throw new Refuse(400, `Pick a rate between ${RATE.min}% and ${RATE.max}%.`);
  const staff = rooms.isStaff(user);
  const t = now();
  return require("./boosts").tx(async () => {
    const cur = (await getQuery("SELECT rate, changed_at FROM room_vault_settings WHERE room_id = ?", [R.id]))[0] || null;
    if (cur && Number(cur.rate) === r) return { rate: r, changed: false };
    if (!staff && cur && cur.changed_at && t - Number(cur.changed_at) < RATE_EVERY_MS) {
      const d = Math.ceil((Number(cur.changed_at) + RATE_EVERY_MS - t) / DAY_MS);
      throw new Refuse(429, `The rate can change once a week - try again in ${d} day${d === 1 ? "" : "s"}.`);
    }
    await runQuery(`INSERT INTO room_vault_settings (room_id, rate, changed_at, changed_by) VALUES (?, ?, ?, ?)
                    ON CONFLICT(room_id) DO UPDATE SET rate = excluded.rate, changed_at = excluded.changed_at, changed_by = excluded.changed_by`,
                   [R.id, r, t, user.userId]);
    await runQuery("INSERT INTO room_vault_rate_log (room_id, rate, prev, by, at) VALUES (?, ?, ?, ?, ?)",
                   [R.id, r, cur ? Number(cur.rate) : RATE.default, user.userId, t]);
    try { await rooms.event(R.id, "vault-rate", user.username || "", `${cur ? cur.rate : RATE.default}% -> ${r}%`); } catch (e) { /* audit only */ }
    return { rate: r, changed: true };
  });
}

const IDEM_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** 1.99sn: anyone signed in donates to a pad's vault -> the keyed website action "roomvault.deposit" (Pepe's !padvault deposit).
 *  Checks here are for a friendly answer; Pepe re-checks the minimum, the cap and the balance under his escrow. */
async function donate(roomId, user, { amount, idem, anon } = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const rooms = require("./rooms");
  const R = await rooms.get(String(roomId || ""));
  if (!R) throw new Refuse(404, "No such pad.");
  if (!hasVault(R.id)) throw new Refuse(400, "This pad has no vault yet.");
  if (!IDEM_RE.test(String(idem || ""))) throw new Refuse(400, "Reload the page and try again.");
  const a = typeof amount === "number" ? amount : /^\s*\d+\s*$/.test(String(amount || "")) ? parseInt(amount, 10) : NaN;
  const c = await card(R.id, user, {});
  if (!c.live) throw new Refuse(409, "Pad vaults aren't open yet.");
  const min = c.deposit_min || 1000, head = Math.max(0, (c.cap || 50000000) - c.balance);
  if (!Number.isFinite(a) || Math.floor(a) !== a || a < min) throw new Refuse(400, `Donate at least ${min.toLocaleString("en-US")} PAT.`);
  if (a > head) throw new Refuse(400, head ? `The vault can take ${head.toLocaleString("en-US")} PAT more (cap ${c.cap.toLocaleString("en-US")}).` : "The vault is full.");
  if (!c.viewer || a > c.viewer.balance) throw new Refuse(400, "You don't have that many PAT.");
  let id;
  try {
    id = await require("./actions").queue(user.userId, { kind: "roomvault.deposit", args: [R.id, String(a)].concat(anon ? ["anon"] : []),
      tag: "vault", label: `${R.title}: donate ${a.toLocaleString("en-US")} PAT to the pad vault${anon ? " (anonymously)" : ""}`, idem: String(idem) });
  } catch (e) {
    if (e && e.message === "busy") throw new Refuse(429, "You already have a few things waiting for Pepe - give him a moment.");
    if (e && e.message === "duplicate") return { id: e.actionId || null, duplicate: true };
    throw e;
  }
  console.log(`[roomvaults] donate room=${R.id} account=${user.username} amount=${a}${anon ? " anon" : ""} action=${id}`);
  return { id };
}

/** The economy page: the total and the biggest vaults (only while live or once anything is in them). */
async function overview(limit = 10) {
  await init();
  const meta = await metaGet();
  const rows = await getQuery("SELECT room_id, balance, days FROM room_vault_state WHERE balance > 0 ORDER BY balance DESC LIMIT ?", [limit]);
  const rooms = require("./rooms");
  const out = [];
  for (const r of rows) {
    let days = {};
    try { days = JSON.parse(r.days || "{}"); } catch (e) { days = {}; }
    const keys = Object.keys(days).sort().slice(-7);
    const R = await rooms.get(r.room_id).catch(() => null);
    // 1.99vy: a profile pad's vault lives on the profile (/u/<name>/vault), not on a pad page
    const href = R && R.profile && R.profile.username ? "/u/" + encodeURIComponent(R.profile.username) + "/vault"
      : R && R.slug ? "/p/" + encodeURIComponent(String(R.slug).toLowerCase()) + "?tab=about#vault" : null;
    out.push({ room_id: r.room_id, title: R ? R.title : r.room_id, slug: R ? R.slug : null, href, balance: int(r.balance),
               inflow7: keys.reduce((s, k) => s + int(days[k].in), 0) });
  }
  return { live: meta.on === true, total: int(meta.total), cap: meta.cap || 50000000, rooms: out,
           recipe: meta.recipe || null };     // E-4: {on, topup, frozen, cfg} - the /economy page's payout recipe card
}

function register(app, { addUser, isBotToken }) {
  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[roomvaults]", e);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
  };
  const resolve = (slug) => require("./roomsweb").resolveRoom(slug);
  app.post("/api/g/roomvaults/sync", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ error: "unauthorized" });
    try { res.json({ ok: true, ...(await sync(b)) }); } catch (e) { fail(res, e); }
  });
  app.get("/api/rooms/:slug/vault", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const R = await resolve(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      const rooms = require("./rooms");
      const manage = await rooms.canManage(req.user, R.id);
      res.json({ ok: true, vault: await card(R.id, req.user, { canManage: manage, staff: rooms.isStaff(req.user) }) });
    } catch (e) { fail(res, e); }
  });
  // 2026-10-12: /admin/economy's 🎁 Activity -> pad vaults card (admin-activitypads.js) - Pepe's switches as he last synced them
  app.get("/api/admin/econ/activity-pads", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || req.user.class !== "Admin") return res.status(403).json({ error: "Admins only." });
    try {
      const m = await metaGet();
      const r = m.recipe || {};
      res.json({ ok: true, synced: m.synced || null, vaults_on: m.on === true, recipe_on: r.on === true, activity_pads: r.activity_pads === true,
                 activity_rewards: r.activity_rewards === true, profile_vaults: m.profile_vaults === true, pool: r.pool || null });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/vault/donate", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.is("application/json") || req.get("X-Requested-With") !== "fetch") throw new Refuse(400, "Bad request.");
      if (!req.user || !req.user.userId) throw new Refuse(401, "Sign in first.");
      const R = await resolve(req.params.slug);
      if (!R) throw new Refuse(404, "No such pad.");
      const b = req.body || {};
      res.json({ ok: true, ...(await donate(R.id, req.user, { amount: b.amount, idem: b.idem, anon: b.anon === true })) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/vault/rate", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.is("application/json")) throw new Refuse(415, "JSON only.");
      if (!req.user || !req.user.userId) throw new Refuse(401, "Sign in first.");
      const R = await resolve(req.params.slug);
      if (!R) throw new Refuse(404, "No such pad.");
      const r = await setRate(R.id, req.user, (req.body || {}).rate);
      const rooms = require("./rooms");
      res.json({ ok: true, ...r, vault: await card(R.id, req.user, { canManage: true, staff: rooms.isStaff(req.user) }) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  profileVaultsOn, hasVault, _setProfileVaults: (v) => { PROFILE_ON = !!v; }, init, sync, settingsMap, card, setRate, donate, overview, register, RATE, Refuse, cleanRecipe,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); } };
