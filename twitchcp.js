// twitchcp.js — 1.99afh: which Twitch channel-point rewards pay PAT, and how much (owner decision 2026-10-26).
//
// Why: the Twitch bot (server.js) used to read the PAT amount out of the reward's TITLE (`title.split(" ")[1]`), so
// whoever named a reward named the payout - a reward titled "Buy 500000 PAT" was redeemed on 2026-10-24 (refused only
// because the incentive budget was short). Now the SITE decides:
//   * only an allow-listed reward pays, and it pays the list's amount - never a number parsed from a title;
//   * no redemption pays more than `cap` (botcredits.js refuses it as "over_cap"); `cap` is never above HARD_CAP;
//   * every other reward ("Buy 500000 PAT", "Pet dog", ...) pays nothing (botcredits.js: "not_allowlisted").
//
//   twitchcp_cfg   key 'cfg' -> {rewards: [{id, title, amount, min_cost}], cap, daily}
//                  rewards  an entry WITH a Twitch reward id matches that reward only (renaming it keeps it, a new reward
//                           with a copied title doesn't match); an entry without one matches the EXACT title - unless an
//                           entry WITH an id carries that same title (the pinned one: a copy under that title pays
//                           nothing). amount 1..HARD_CAP. Defaults: "Buy 5000 PAT" = 5,000 and "Buy 25000 PAT" = 25,000
//                           by title (the reward ids weren't known when this shipped - the bot never logged them; pin
//                           them from the card after the first redemptions: an owner's runbook step).
//                  min_cost (1.99afh review) the fewest channel points the reward must cost on Twitch for this entry to pay
//                           (the bot sends the redemption's reward.cost; below it / missing -> "under_cost"), 0..MAX_COST,
//                           0 = not checked. Default (and when a saved entry has none): the entry's amount, i.e. at most
//                           1 PAT per channel point - so whoever can edit the channel's rewards can't make "Buy 25000 PAT"
//                           cost 1 point and let viewers farm the incentive budget. The card shows each reward's cost as
//                           Twitch last sent it ("Rewards seen") to set this from.
//                  cap      the most one redemption pays, 0..HARD_CAP (0 = channel-point PAT paused). Lower it to pause the
//                           bigger rewards without editing them.
//                  daily    (1.99afh review) the most PAT one PATV account (one Twitch user) gets from channel points in any
//                           24 hours, 1..MAX_DAILY, or null = no per-viewer limit. Default DEFAULT_DAILY (50,000). Checked
//                           inside the payment's transaction (botcredits.js "over_daily").
//   twitchcp_seen  reward_key PK, reward_id, title, n, last_ts, last_outcome, last_cost - the rewards the bot has asked about
//                  (no viewer data), so an admin can pin a title to its reward id and set its minimum cost. The newest
//                  SEEN_KEEP are kept.
//
//   GET  /api/admin/twitch-cp  (econ.codes_view)   -> {ok, cfg, defaults, hard_cap, max_cost, max_daily, seen, can_edit}
//   POST /api/admin/twitch-cp  (econ.codes_manage + a Pepe owner, same-site fetch) {rewards, cap, daily} -> {ok, cfg}  (admin_audit)
// The card is /admin/economy#twitchcp (views/partials/admin-twitchcp.ejs, public/js/admin-twitchcp.js). Like a redemption
// code, an allow-listed reward is PAT members can claim, so changing the list is a Pepe owner's (staffroles.ownerOf).
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");

const HARD_CAP = 25000;
const MAX_REWARDS = 20;
const SEEN_KEEP = 100;
const TITLE_MAX = 45;                      // Twitch's own limit for a custom reward's title
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;      // Twitch reward ids are UUIDs
const MAX_COST = 1000000000;               // channel points (a minimum cost above any real reward's price)
const DEFAULT_DAILY = 50000;               // PAT per PATV account per 24 hours from channel points
const MAX_DAILY = 1000000;
const DEFAULTS = Object.freeze({
  rewards: Object.freeze([
    Object.freeze({ id: null, title: "Buy 5000 PAT", amount: 5000, min_cost: 5000 }),
    Object.freeze({ id: null, title: "Buy 25000 PAT", amount: 25000, min_cost: 25000 }),
  ]),
  cap: HARD_CAP,
  daily: DEFAULT_DAILY,
});
const copy = (c) => ({ rewards: c.rewards.map((r) => ({ id: r.id, title: r.title, amount: r.amount, min_cost: r.min_cost })), cap: c.cap, daily: c.daily });

let ready = null;
function init() {
  if (!ready) {
    ready = runQuery("CREATE TABLE IF NOT EXISTS twitchcp_cfg (key TEXT PRIMARY KEY, value TEXT, updated INTEGER, by TEXT)")
      .then(() => runQuery(`CREATE TABLE IF NOT EXISTS twitchcp_seen (reward_key TEXT PRIMARY KEY, reward_id TEXT, title TEXT, n INTEGER DEFAULT 0,
                                                                     last_ts INTEGER, last_outcome TEXT, last_cost INTEGER)`))
      .then(async () => {
        // 1.99afh review: the reward's cost as Twitch last sent it (a table made before it has no column)
        const cols = (await getQuery("SELECT name FROM pragma_table_info('twitchcp_seen')")).map((r) => r.name);
        if (!cols.includes("last_cost")) await runQuery("ALTER TABLE twitchcp_seen ADD COLUMN last_cost INTEGER");
      })
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const isInt = (v) => typeof v === "number" ? Number.isInteger(v) : (typeof v === "string" && /^\s*\d+\s*$/.test(v));
const blank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/**
 * Check a whole config ({rewards, cap, daily}). -> {ok: true, cfg} | {ok: false, error}. Never trusts a title for an amount.
 * A reward's min_cost left out / blank = its amount (1 PAT per channel point); `daily` left out = DEFAULT_DAILY, null / blank =
 * no per-viewer limit.
 */
function validate(input) {
  const c = input && typeof input === "object" ? input : {};
  if (!isInt(c.cap) || Number(c.cap) < 0 || Number(c.cap) > HARD_CAP) return { ok: false, error: `cap must be a whole number from 0 to ${HARD_CAP}` };
  let daily = DEFAULT_DAILY;
  if (c.daily !== undefined) {
    if (blank(c.daily)) daily = null;
    else if (!isInt(c.daily) || Number(c.daily) < 1 || Number(c.daily) > MAX_DAILY) return { ok: false, error: `the daily limit per viewer must be a whole number from 1 to ${MAX_DAILY} (or blank for none)` };
    else daily = Number(c.daily);
  }
  if (!Array.isArray(c.rewards)) return { ok: false, error: "rewards must be a list" };
  if (c.rewards.length > MAX_REWARDS) return { ok: false, error: `at most ${MAX_REWARDS} rewards` };
  const rewards = [], ids = new Set(), titles = new Set();
  for (const [i, r] of c.rewards.entries()) {
    const n = `reward ${i + 1}`;
    if (!r || typeof r !== "object") return { ok: false, error: `${n}: not a reward` };
    const id = r.id === undefined || r.id === null || String(r.id).trim() === "" ? null : String(r.id).trim();
    const title = r.title === undefined || r.title === null || String(r.title).trim() === "" ? null : String(r.title).trim();
    if (id !== null && !ID_RE.test(id)) return { ok: false, error: `${n}: the reward id is letters, digits and dashes (a Twitch reward UUID)` };
    if (title !== null && title.length > TITLE_MAX) return { ok: false, error: `${n}: a title is at most ${TITLE_MAX} characters` };
    if (id === null && title === null) return { ok: false, error: `${n}: needs a reward id or an exact title` };
    if (!isInt(r.amount) || Number(r.amount) < 1 || Number(r.amount) > HARD_CAP) return { ok: false, error: `${n}: PAT must be a whole number from 1 to ${HARD_CAP}` };
    if (!blank(r.min_cost) && (!isInt(r.min_cost) || Number(r.min_cost) < 0 || Number(r.min_cost) > MAX_COST)) {
      return { ok: false, error: `${n}: the minimum cost is a whole number of channel points from 0 to ${MAX_COST} (blank = the PAT amount)` };
    }
    if (id !== null) { if (ids.has(id)) return { ok: false, error: `${n}: that reward id is listed twice` }; ids.add(id); }
    else { if (titles.has(title)) return { ok: false, error: `${n}: that title is listed twice` }; titles.add(title); }
    rewards.push({ id, title, amount: Number(r.amount), min_cost: blank(r.min_cost) ? Number(r.amount) : Number(r.min_cost) });
  }
  return { ok: true, cfg: { rewards, cap: Number(c.cap), daily } };
}

let cache = null, cacheAt = 0;
async function get() {
  if (cache && Date.now() - cacheAt < 15000) return cache;
  await init();
  const row = (await getQuery("SELECT value FROM twitchcp_cfg WHERE key = 'cfg'"))[0];
  let cfg = copy(DEFAULTS);
  if (row) {
    let raw = null;
    try { raw = JSON.parse(row.value); } catch (e) { raw = null; }
    const v = validate(raw);
    if (v.ok) cfg = v.cfg;
    else console.error(`[twitchcp] the saved allowlist is unreadable (${v.error || "bad JSON"}) - using the defaults`);
  }
  cache = cfg;
  cacheAt = Date.now();
  return cache;
}

async function set(input, by) {
  const v = validate(input);
  if (!v.ok) return v;
  await init();
  await runQuery(`INSERT INTO twitchcp_cfg (key, value, updated, by) VALUES ('cfg', ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by`,
                 [JSON.stringify(v.cfg), Date.now(), by ? String(by).slice(0, 80) : null]);
  cache = v.cfg;
  cacheAt = Date.now();
  return v;
}

/**
 * The allow-list entry a redeemed reward ({id, title}) pays by, or null. An entry with an id matches that id only; an
 * entry without one matches the exact title (no trimming, no case folding) - unless an entry WITH an id carries that title
 * (1.99afh review: once a reward is pinned, another reward given its title pays nothing). An id match wins.
 * -> {amount, min_cost, by: "id" | "title", entry}
 */
function resolve(reward, cfg) {
  const r = reward && typeof reward === "object" ? reward : {};
  const id = typeof r.id === "string" && r.id ? r.id : null;
  const title = typeof r.title === "string" ? r.title : null;
  const list = (cfg && Array.isArray(cfg.rewards)) ? cfg.rewards : [];
  const out = (hit, by) => ({ amount: hit.amount, min_cost: Number.isInteger(hit.min_cost) ? hit.min_cost : hit.amount, by, entry: hit });
  if (id) { const hit = list.find((e) => e.id && e.id === id); if (hit) return out(hit, "id"); }
  if (title !== null && !list.some((e) => e.id && e.title === title)) {
    const hit = list.find((e) => !e.id && e.title === title);
    if (hit) return out(hit, "title");
  }
  return null;
}

/** Remember a reward the bot asked about (for the admin card): {id, title, cost}. Never throws. */
async function noteSeen(reward, outcome) {
  try {
    const r = reward && typeof reward === "object" ? reward : {};
    const id = typeof r.id === "string" && ID_RE.test(r.id) ? r.id : null;
    const title = typeof r.title === "string" ? r.title.slice(0, 120) : null;
    const cost = Number.isSafeInteger(r.cost) && r.cost >= 0 ? r.cost : null;
    if (!id && !title) return;
    await init();
    const key = id ? "id:" + id : "title:" + title;
    await runQuery(`INSERT INTO twitchcp_seen (reward_key, reward_id, title, n, last_ts, last_outcome, last_cost) VALUES (?, ?, ?, 1, ?, ?, ?)
                    ON CONFLICT(reward_key) DO UPDATE SET title = excluded.title, n = twitchcp_seen.n + 1, last_ts = excluded.last_ts,
                      last_outcome = excluded.last_outcome, last_cost = excluded.last_cost`,
                   [key, id, title, Date.now(), String(outcome || "").slice(0, 40), cost]);
    await runQuery(`DELETE FROM twitchcp_seen WHERE reward_key NOT IN (SELECT reward_key FROM twitchcp_seen ORDER BY last_ts DESC LIMIT ${SEEN_KEEP})`);
  } catch (e) { console.error("[twitchcp] seen:", e.message); }
}

async function seen(limit = 50) {
  await init();
  return getQuery("SELECT reward_id, title, n, last_ts, last_outcome, last_cost FROM twitchcp_seen ORDER BY last_ts DESC LIMIT ?", [Math.max(1, Math.min(SEEN_KEEP, limit))]);
}

function register(app, { addUser }) {
  init().catch((e) => console.error("[twitchcp] init:", e.message));
  const viewer = async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false }); return null; }
    const row = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!row || !SP.can(row, "econ.codes_view")) { res.status(403).json({ ok: false, error: "Admins only." }); return null; }
    return row;
  };
  app.get("/api/admin/twitch-cp", addUser, async (req, res) => {
    const row = await viewer(req, res);
    if (!row) return;
    try {
      const canEdit = SP.can(row, "econ.codes_manage") && !!(await require("./staffroles").ownerOf(req.user, "econ.codes_manage").catch(() => null));
      res.json({ ok: true, cfg: await get(), defaults: copy(DEFAULTS), hard_cap: HARD_CAP, max_cost: MAX_COST, max_daily: MAX_DAILY, seen: await seen(), can_edit: canEdit });
    } catch (e) {
      console.error("[twitchcp] view:", e.message);
      res.status(500).json({ ok: false, error: "failed" });
    }
  });
  app.post("/api/admin/twitch-cp", addUser, async (req, res) => {
    const row = await viewer(req, res);
    if (!row) return;
    if (!SP.can(row, "econ.codes_manage")) return res.status(403).json({ ok: false, error: "Admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    const SR = require("./staffroles");
    if (!(await SR.ownerOf(req.user, "econ.codes_manage").catch(() => null))) return res.status(403).json({ ok: false, error: SR.OWNER_ONLY });
    const b = req.body || {};
    try {
      const before = await get();
      const r = await set({ rewards: b.rewards, cap: b.cap, daily: b.daily }, row.username || row.userId);
      if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
      console.log(`[twitchcp] ${row.username || row.userId}: ${r.cfg.rewards.length} channel-point reward(s) pay PAT, cap ${r.cfg.cap}, daily ${r.cfg.daily === null ? "none" : r.cfg.daily}`);
      await require("./adminaudit").record(req.user, "twitch-cp", null, { before, after: r.cfg }).catch((e) => console.warn(`[twitchcp] audit: ${e.message}`));
      res.json({ ok: true, cfg: r.cfg });
    } catch (e) {
      console.error("[twitchcp] save:", e.message);
      res.status(500).json({ ok: false, error: "Not saved." });
    }
  });
}

module.exports = { register, init, get, set, validate, resolve, noteSeen, seen, DEFAULTS, HARD_CAP, MAX_COST, DEFAULT_DAILY, MAX_DAILY,
                   _reset: () => { cache = null; } };
