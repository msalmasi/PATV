// launchpad.js — the PAD LAUNCHPAD on the site (camfrog-bot docs/ECONOMY-V2.md section 15; Pepe's pepe_launchpad.py,
// flag econ_launchpad). The fix for the PAT cold start of a new pad: nobody there has PAT, so nothing can happen.
//
// Pepe owns the money and every number: his funding sync carries `launchpad` = {on, live, room_vaults, cfg, budget,
// spendable, matched, paid} (funding.state.launchpad; null = off). The site:
//
//   1. MOMENTUM -> LAUNCH GRANTS. For every launch pad (a user-owned pad - Camfrog, site or Twitch - registered after
//      cfg.since, or enrolled by an admin, within cfg.max_age_days of its launch start) it counts, over a rolling
//      cfg.window_days, from data that already exists:
//        - E-0 participation (econ_participation: chat lines + mic minutes per Camfrog login per room per day),
//        - the pad's feed posts and comments (feed_post_rooms / feed_posts / feed_comments),
//        - signed-in visits of the pad page (launchpad_visits - recorded only for open launch pads, by the launch
//          widget's GET; a visit alone never counts as activity, it only makes someone "returning").
//      Only QUALIFIED accounts count: at least cfg.min_account_days old and cfg.min_level, a linked identity (Camfrog,
//      Discord, Twitch or a verified non-disposable email - welcome.js's rule), not flagged by the welcome-bonus
//      dedupe (welcome_bonus state 'duplicate' / dup_of), never the owner or an account sharing a strong identity key
//      with the owner, never Pepe's own accounts. Accounts that share a strong identity key (welcome_keys: Camfrog
//      identity, Discord, Twitch, email, browser) are ONE person.
//        regular    = a person active on >= cfg.regular_days different days of the window (posts / chat / mic; a
//                     signed-in visit counts as a day once they've been active at least once)
//        active day = a day with >= cfg.active_day_people people active in the pad
//      Each tier [regulars, active days, grant] reached inside the launch window records ONE graduation row per (pad,
//      tier), ever (UNIQUE). With cfg.review (default on) an admin approves it on /admin/economy; then Pepe pays HIS
//      tier amount from the incentive budget into the pad's room vault and marks the row paid (POST
//      /api/g/launchpad/paid). Rejected rows are never offered again.
//   2. NEWCOMER WELCOME. While the launchpad is live, a person's first activity in an open launch pad pays them
//      cfg.welcome_amount once per person, globally (launchpad_welcomes PK user_id + no earlier welcome for an account
//      sharing a strong identity key), at most cfg.welcome_per_pad per pad, for accounts >= cfg.welcome_min_age_hours
//      old, linked, not duplicates, not the owner. Paid here in one DB transaction (welcome row + ledger.post with
//      transaction id lpw-<user> + the claim "incentives:launchpad_welcome" that Pepe settles against the launchpad
//      group), only when the group's room and the spendable budget (net of every unsettled incentive claim) cover it;
//      otherwise it simply isn't paid yet and the next evaluation tries again (no queue).
//   3. OWNER MATCHING happens in Pepe (!roomvault deposit); the site shows what was matched (state.matched).
//   4. BOOST CREDIT: for cfg.boost_days after its launch start a pad gets cfg.boost_credit_pat of virtual active boost
//      PAT in the front-page ranking (boosts.activeMap(.., {credits: true})) - the normal boost rules (sqrt, cap, half
//      the activity, nothing while quiet), no PAT charged or moved.
//
// Tables: launchpad_pads (room_id PK, enrolled_at, enrolled_by, excluded, note) · launchpad_grads (id, room_id, tier,
// amount, state review|approved|paid|rejected|refused, metrics JSON, created, decided, decided_by, reason, paid_amount,
// tid, paid_at; UNIQUE(room_id, tier)) · launchpad_welcomes (user_id PK, room_id, amount, state paid|dup, created) ·
// launchpad_visits (room_id, user_id, day PK).
// Routes: GET /api/rooms/:slug/launch (public; owner / staff get the details) · GET /api/admin/launchpad · POST
// /api/admin/launchpad/grad {id, action approve|reject, reason} · POST /api/admin/launchpad/pad {room, action
// enroll|exclude|include} (admins) · POST /api/g/launchpad/pending + /api/g/launchpad/paid (Pepe, bot token).
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

// What the site shows before Pepe has ever synced (the real numbers always come from Pepe's cfg).
const DEFAULTS = Object.freeze({
  weekly_cap: 1000000, keep_balance: 2000000, review: true, window_days: 14, max_age_days: 45, since: 0, regular_days: 2,
  active_day_people: 3, min_account_days: 7, min_level: 2, chat_lines: 5, mic_min: 2,
  tiers: [[10, 4, 150000], [20, 7, 300000], [30, 10, 550000]],
  welcome_amount: 5000, welcome_min_age_hours: 24, welcome_per_pad: 30, match_days: 30, match_ratio_pct: 100,
  match_cap: 250000, boost_days: 7, boost_credit_pat: 10000,
});
const PLATFORMS = new Set(["camfrog", "site", "twitch"]);
const STRONG = ["cf", "discord", "twitch", "email", "dev"];
const PEPE_LOGINS = new Set(["pepefrog", "pepebeta"]);
const FRESH_MS = 15 * 60 * 1000;          // a launchpad state older than this pays nothing
const EVAL_MS = 5 * 60 * 1000;
const CACHE_MS = 60 * 1000;
const DAY = 86400000;
const MIC_DAY_CAP = 120;                  // mic minutes counted per person per day (display metric)

let clock = () => Date.now();
const now = () => clock();
const day = (t) => new Date(t).toISOString().slice(0, 10);
const int = (v, d = 0) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : d; };

class Refuse extends Error {
  constructor(status, message) { super(message); this.status = status; this.refuse = true; }
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS launchpad_pads (room_id TEXT PRIMARY KEY, enrolled_at INTEGER, enrolled_by TEXT,
        excluded INTEGER NOT NULL DEFAULT 0, note TEXT, updated INTEGER)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS launchpad_grads (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL,
        tier INTEGER NOT NULL, amount INTEGER NOT NULL, state TEXT NOT NULL, metrics TEXT, created INTEGER NOT NULL,
        decided INTEGER, decided_by TEXT, reason TEXT, paid_amount INTEGER, tid TEXT, paid_at INTEGER)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS launchpad_grads_tier ON launchpad_grads (room_id, tier)");
      await runQuery("CREATE INDEX IF NOT EXISTS launchpad_grads_state ON launchpad_grads (state, id)");
      await runQuery(`CREATE TABLE IF NOT EXISTS launchpad_welcomes (user_id TEXT PRIMARY KEY, room_id TEXT NOT NULL,
        amount INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT, created INTEGER NOT NULL)`);
      await runQuery("CREATE INDEX IF NOT EXISTS launchpad_welcomes_room ON launchpad_welcomes (room_id, state)");
      await runQuery(`CREATE TABLE IF NOT EXISTS launchpad_visits (room_id TEXT NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL,
        PRIMARY KEY (room_id, user_id, day))`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── Pepe's state (funding.state.launchpad) ──
function cleanTiers(t) {
  const out = [];
  for (const x of Array.isArray(t) ? t.slice(0, 5) : []) {
    if (!Array.isArray(x) || x.length < 3) return null;
    const r = int(x[0], -1), d = int(x[1], -1), g = int(x[2], -1);
    if (r < 1 || d < 0 || g < 0) return null;
    if (out.length && r <= out[out.length - 1][0]) return null;
    out.push([r, d, g]);
  }
  return out.length ? out : null;
}
function cleanCfg(c) {
  const o = {};
  c = c && typeof c === "object" ? c : {};
  for (const [k, d] of Object.entries(DEFAULTS)) {
    if (k === "tiers") { o.tiers = cleanTiers(c.tiers) || DEFAULTS.tiers.map((x) => x.slice()); continue; }
    if (k === "review") { o.review = c.review === undefined ? d : !!c.review; continue; }
    const n = int(c[k], d);
    o[k] = n < 0 ? d : n;
  }
  return o;
}
/** Pepe's sync body.launchpad -> the state the site keeps (null = the launchpad is off). */
function cleanState(x) {
  if (!x || typeof x !== "object" || x.on !== true) return null;
  const num = (o) => { const r = {}; for (const [k, v] of Object.entries(o && typeof o === "object" ? o : {}).slice(0, 2000)) { const n = int(v, NaN); if (Number.isFinite(n)) r[String(k).slice(0, 140)] = Math.max(0, n); } return r; };
  return { on: true, live: x.live === true, room_vaults: x.room_vaults === true, cfg: cleanCfg(x.cfg),
           week: x.week ? String(x.week).slice(0, 16) : null,
           budget: { cap: Math.max(0, int((x.budget || {}).cap)), left: Math.max(0, int((x.budget || {}).left)) },
           spendable: Math.max(0, int(x.spendable)), matched: num(x.matched), paid: num(x.paid), at: now() };
}
function state() {
  try { return require("./funding").state.launchpad || null; } catch (e) { return null; }
}
const isOn = () => !!state();
/** Money may move on the site (welcomes): on, live in Pepe, and synced recently. */
function isLive() {
  const s = state();
  return !!(s && s.live && now() - (s.at || 0) < FRESH_MS);
}
const cfg = () => (state() ? state().cfg : cleanCfg(DEFAULTS));

// ── users ──
let UCOLS = null;
async function ucols() {
  if (!UCOLS) UCOLS = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  return UCOLS;
}
const col = (C, c) => (C.has(c) ? `u.${c}` : "NULL");
function ageMs(createdAt) {
  if (createdAt == null || createdAt === "") return 0;
  const n = Number(createdAt);
  const t = Number.isFinite(n) && n > 1e11 ? n : Date.parse(String(createdAt).replace(" ", "T") + (/[zZ+]/.test(String(createdAt)) ? "" : "Z"));
  return Number.isFinite(t) ? Math.max(0, now() - t) : 0;
}
const DISPOSABLE_RE = /(^|\.)(mailinator|guerrillamail|sharklasers|10minutemail|temp-?mail|yopmail|trashmail|getnada|dispostable|maildrop|throwawaymail|fakeinbox)\./i;
function linked(u) {
  if (u.camfrogUsername || u.discordId || u.twitchId) return true;
  const e = String(u.email || "").toLowerCase();
  return Number(u.isEmailVerified) === 1 && /@/.test(e) && !DISPOSABLE_RE.test(e.split("@")[1] + ".");
}
async function usersById(ids) {
  const out = new Map();
  ids = [...new Set(ids.filter(Boolean))];
  if (!ids.length) return out;
  const C = await ucols();
  for (let i = 0; i < ids.length; i += 300) {
    const part = ids.slice(i, i + 300);
    const rows = await getQuery(`SELECT u.userId, u.username, ${col(C, "level")} AS level, ${col(C, "created_at")} AS created_at,
      ${col(C, "camfrogUsername")} AS camfrogUsername, ${col(C, "discordId")} AS discordId, ${col(C, "twitchId")} AS twitchId,
      ${col(C, "email")} AS email, ${col(C, "isEmailVerified")} AS isEmailVerified FROM users u
      WHERE u.userId IN (${part.map(() => "?").join(",")})`, part);
    for (const r of rows) out.set(r.userId, r);
  }
  let dups = [];
  try { dups = await getQuery(`SELECT userId, state, dup_of FROM welcome_bonus WHERE userId IN (${ids.map(() => "?").join(",")})`, ids); } catch (e) { dups = []; }
  for (const d of dups) { const u = out.get(d.userId); if (u) { u.wb_state = d.state; u.dup_of = d.dup_of; } }
  return out;
}
/** Camfrog logins -> userId (a real account ahead of a leftover automatic CF one, like boosts.js / displaynames). */
async function usersByLogin(logins) {
  const out = new Map();
  logins = [...new Set(logins.map((l) => String(l || "").toLowerCase()).filter(Boolean))];
  if (!logins.length || !(await ucols()).has("camfrogUsername")) return out;
  for (let i = 0; i < logins.length; i += 300) {
    const part = logins.slice(i, i + 300);
    const rows = await getQuery(`SELECT userId, LOWER(camfrogUsername) AS l, username FROM users WHERE LOWER(camfrogUsername) IN (${part.map(() => "?").join(",")})
      ORDER BY (username GLOB 'CF[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]') DESC, rowid DESC`, part);
    for (const r of rows) out.set(r.l, r.userId);        // last write wins: the real account, oldest first
  }
  return out;
}
async function strongKeys(ids) {
  const out = new Map();
  ids = [...new Set(ids)];
  if (!ids.length) return out;
  try {
    for (let i = 0; i < ids.length; i += 300) {
      const part = ids.slice(i, i + 300);
      const rows = await getQuery(`SELECT userId, k FROM welcome_keys WHERE kind IN (${STRONG.map(() => "?").join(",")}) AND userId IN (${part.map(() => "?").join(",")})`,
        [...STRONG, ...part]);
      for (const r of rows) { if (!out.has(r.userId)) out.set(r.userId, new Set()); out.get(r.userId).add(r.k); }
    }
  } catch (e) { /* no welcome_keys table: nobody shares keys */ }
  return out;
}
/** Union accounts sharing a strong identity key -> userId -> person id (the smallest userId of the cluster). */
function clusters(ids, keys) {
  const parent = new Map(ids.map((i) => [i, i]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const byKey = new Map();
  for (const id of ids) for (const k of keys.get(id) || []) {
    if (byKey.has(k)) { const a = find(id), b = find(byKey.get(k)); if (a !== b) parent.set(a < b ? b : a, a < b ? a : b); }
    else byKey.set(k, id);
  }
  const out = new Map();
  for (const id of ids) out.set(id, find(id));
  return out;
}

// ── launch pads ──
async function enrollments() {
  await init();
  const m = new Map();
  for (const r of await getQuery("SELECT room_id, enrolled_at, enrolled_by, excluded, note FROM launchpad_pads")) m.set(r.room_id, r);
  return m;
}
/** Every pad that is (or was) on the launchpad: [{id, slug, title, platform, owner, start, ends, open, enrolled}] */
async function launchPads(t = now()) {
  await init();
  const rooms = require("./rooms");
  await rooms.init();
  const c = cfg();
  const s = state();
  // no since (Pepe never armed it) = no automatic launch pads at all, only enrolled ones: never retroactive
  const since = s && c.since > 0 ? c.since : Infinity;
  const created = new Map((await getQuery("SELECT room_id, created FROM rooms_registry")).map((r) => [r.room_id, Number(r.created) || 0]));
  const en = await enrollments();
  const out = [];
  for (const R of await rooms.list()) {
    const e = en.get(R.id);
    if (e && e.excluded) continue;
    if (!PLATFORMS.has(R.platform) || R.house || R.owner_kind !== "user" || !R.owner) continue;
    const start = e && e.enrolled_at ? Number(e.enrolled_at) : created.get(R.id) || 0;
    if (!start || (!(e && e.enrolled_at) && start < since)) continue;
    const ends = start + c.max_age_days * DAY;
    out.push({ id: R.id, slug: R.slug, title: R.title, platform: R.platform, owner: R.owner, start, ends, open: t < ends,
               enrolled: !!(e && e.enrolled_at) });
  }
  return out;
}

// ── momentum (pure-ish: reads, never writes) ──
async function activity(pad, from, to) {
  const c = cfg();
  const fromDay = day(from);
  const per = new Map();                       // userId -> {real: Set(day), visit: Set(day), lines, mic: {day: min}, posts, comments, first}
  const get = (u) => { let x = per.get(u); if (!x) { x = { real: new Set(), visit: new Set(), lines: 0, mic: {}, chat: false, posts: 0, comments: 0, first: Infinity }; per.set(u, x); } return x; };
  let part = [];
  try { part = await getQuery("SELECT day, login, lines, mic_min FROM econ_participation WHERE room_id = ? AND day >= ?", [pad.id, fromDay]); } catch (e) { part = []; }
  const byLogin = await usersByLogin(part.map((p) => p.login).filter((l) => !PEPE_LOGINS.has(String(l).toLowerCase())));
  for (const p of part) {
    const u = byLogin.get(String(p.login).toLowerCase());
    if (!u) continue;
    const x = get(u);
    const lines = int(p.lines), mic = Number(p.mic_min) || 0;
    x.lines += lines;
    x.mic[p.day] = Math.min(MIC_DAY_CAP, (x.mic[p.day] || 0) + mic);
    if (lines >= c.chat_lines) x.chat = true;
    if (lines >= c.chat_lines || mic >= c.mic_min) { x.real.add(p.day); x.first = Math.min(x.first, Date.parse(p.day + "T00:00:00Z")); }
  }
  try {
    const posts = await getQuery(`SELECT p.author_id AS u, p.created AS t FROM feed_post_rooms r JOIN feed_posts p ON p.id = r.post_id
      WHERE r.room_id = ? AND p.created >= ? AND p.created <= ? AND r.removed_at IS NULL AND p.deleted_at IS NULL AND p.hidden_at IS NULL`, [pad.id, from, to]);
    for (const p of posts) { const x = get(p.u); x.posts++; x.real.add(day(p.t)); x.first = Math.min(x.first, Number(p.t)); }
  } catch (e) { /* no feed tables */ }
  try {
    const cm = await getQuery(`SELECT c.author_id AS u, c.created AS t FROM feed_comments c JOIN feed_post_rooms r ON r.post_id = c.post_id
      WHERE r.room_id = ? AND c.created >= ? AND c.created <= ? AND c.deleted_at IS NULL AND r.removed_at IS NULL`, [pad.id, from, to]);
    for (const p of cm) { const x = get(p.u); x.comments++; x.real.add(day(p.t)); x.first = Math.min(x.first, Number(p.t)); }
  } catch (e) { /* no feed tables */ }
  for (const v of await getQuery("SELECT user_id, day FROM launchpad_visits WHERE room_id = ? AND day >= ?", [pad.id, fromDay])) get(v.user_id).visit.add(v.day);
  return per;
}

/** Why an account doesn't count (null = it counts). kind 'regular' | 'welcome'. */
function disqualify(u, kind, c, owner, ownerKeys, keys) {
  if (!u) return "no account";
  if (owner && (u.userId === owner.userId || u.dup_of === owner.userId || (owner.dup_of && owner.dup_of === u.userId))) return "owner";
  for (const k of keys.get(u.userId) || []) if (ownerKeys.has(k)) return "owner";
  if (u.camfrogUsername && PEPE_LOGINS.has(String(u.camfrogUsername).toLowerCase())) return "bot";
  if (u.wb_state === "duplicate" || u.dup_of) return "duplicate";
  if (!linked(u)) return "unlinked";
  const age = ageMs(u.created_at);
  if (kind === "welcome") { if (age < c.welcome_min_age_hours * 3600000) return "too new"; return null; }
  if (age < c.min_account_days * DAY) return "too new";
  if ((Number(u.level) || 0) < c.min_level) return "low level";
  return null;
}

const mcache = new Map();
/** A pad's momentum now: {from, to, regulars, active_days, chatters, mic_min, posts, comments, returning, excluded,
 *  reached: [tier numbers], people: [{person, userIds, first}] (welcome candidates)} */
async function metrics(pad, t = now(), { fresh = false } = {}) {
  const key = pad.id;
  const hit = mcache.get(key);
  if (!fresh && hit && t - hit.at < CACHE_MS && hit.start === pad.start) return hit.m;
  const c = cfg();
  const to = Math.min(t, pad.ends);
  const from = Math.max(pad.start, to - c.window_days * DAY);
  const per = await activity(pad, from, to);
  const ids = [...per.keys()];
  const owner = pad.owner ? { userId: pad.owner.userId } : null;
  const U = await usersById(ids.concat(owner ? [owner.userId] : []));
  if (owner && U.get(owner.userId)) owner.dup_of = U.get(owner.userId).dup_of || null;
  const keys = await strongKeys(ids.concat(owner ? [owner.userId] : []));
  const ownerKeys = owner ? keys.get(owner.userId) || new Set() : new Set();
  const excluded = {};
  const ok = [], welcomeOk = [];
  for (const id of ids) {
    const u = U.get(id);
    const why = disqualify(u, "regular", c, owner, ownerKeys, keys);
    if (why) excluded[why] = (excluded[why] || 0) + 1; else ok.push(id);
    if (!disqualify(u, "welcome", c, owner, ownerKeys, keys) && per.get(id).real.size) welcomeOk.push(id);
  }
  const P = clusters(ok, keys);
  const persons = new Map();
  for (const id of ok) {
    const pid = P.get(id);
    let p = persons.get(pid);
    if (!p) { p = { real: new Set(), all: new Set(), chat: false, mic: 0, posts: 0, comments: 0 }; persons.set(pid, p); }
    const x = per.get(id);
    for (const d of x.real) { p.real.add(d); p.all.add(d); }
    for (const d of x.visit) p.all.add(d);
    p.chat = p.chat || x.chat;
    p.mic += Object.values(x.mic).reduce((s, v) => s + v, 0);
    p.posts += x.posts; p.comments += x.comments;
  }
  const dayPeople = new Map();
  let regulars = 0, chatters = 0, mic = 0, posts = 0, comments = 0, returning = 0;
  for (const p of persons.values()) {
    if (p.real.size && p.all.size >= c.regular_days) regulars++;
    if (p.all.size >= 2 && p.real.size) returning++;
    if (p.chat) chatters++;
    mic += p.mic; posts += p.posts; comments += p.comments;
    for (const d of p.real) dayPeople.set(d, (dayPeople.get(d) || 0) + 1);
  }
  const activeDays = [...dayPeople.values()].filter((n) => n >= c.active_day_people).length;
  const reached = [];
  c.tiers.forEach((tr, i) => { if (regulars >= tr[0] && activeDays >= tr[1]) reached.push(i + 1); });
  const wc = clusters(welcomeOk, keys);
  const people = new Map();
  for (const id of welcomeOk) {
    const pid = wc.get(id);
    const p = people.get(pid) || { person: pid, userIds: [], first: Infinity };
    p.userIds.push(id);
    p.first = Math.min(p.first, per.get(id).first);
    people.set(pid, p);
  }
  const m = { from, to, regulars, active_days: activeDays, chatters, mic_min: Math.round(mic), posts, comments, returning,
              excluded, reached, people: [...people.values()].sort((a, b) => a.first - b.first),
              welcomeKeys: keys };
  mcache.set(key, { at: t, start: pad.start, m });
  if (mcache.size > 500) mcache.clear();
  return m;
}

// ── graduations ──
async function grads(roomId) {
  await init();
  return getQuery("SELECT * FROM launchpad_grads WHERE room_id = ? ORDER BY tier", [roomId]);
}
async function recordGrads(pad, m, t = now()) {
  const c = cfg();
  const made = [];
  for (const n of m.reached) {
    const tr = c.tiers[n - 1];
    const st = c.review ? "review" : "approved";
    const r = await runQuery(`INSERT OR IGNORE INTO launchpad_grads (room_id, tier, amount, state, metrics, created, decided, decided_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [pad.id, n, tr[2], st,
      JSON.stringify({ regulars: m.regulars, active_days: m.active_days, chatters: m.chatters, mic_min: m.mic_min, posts: m.posts,
                       comments: m.comments, returning: m.returning, excluded: m.excluded, window: [m.from, m.to] }),
      t, c.review ? null : t, c.review ? null : "auto (review off)"]);
    if (r && r.changes) made.push(n);
  }
  if (made.length) {
    const last = Math.max(...made) === c.tiers.length;
    try {
      await require("./rooms").notify(pad.owner.userId, { kind: "system", title: last ? `🚀 p/${pad.slug} graduated from the launchpad!` : `🚀 p/${pad.slug} hit launch tier ${Math.max(...made)}`,
        body: `${m.regulars} regulars over ${m.active_days} active days. ${c.review ? "An admin reviews it, then" : "Pepe"} pays the launch grant into your pad's room vault.`,
        link: `/p/${encodeURIComponent(pad.slug)}`, ref: `lpgrad:${pad.id}:${Math.max(...made)}` });
    } catch (e) { /* a notice never blocks */ }
    console.log(`[launchpad] ${pad.id}: tier(s) ${made.join(", ")} reached (${m.regulars} regulars, ${m.active_days} active days)`);
  }
  return made;
}

// ── newcomer welcomes ──
async function welcomeRoom() {
  const f = require("./funding");
  const s = state();
  if (!s || !isLive() || !f.state.incentives) return 0;
  const g = f.groupOf("launchpad_welcome");
  if (g !== "launchpad") return 0;
  // the group's room this week and the budget above keep_balance, both net of what the site paid but Pepe hasn't settled
  const left = (Number((f.state.incentives.remaining || {}).launchpad) || 0) - (await f.unsettledIncentives("launchpad"));
  const bal = (Number(f.state.incentives.balance) || 0) - s.cfg.keep_balance - (await f.unsettledIncentives());
  return Math.max(0, Math.min(left, bal));
}
async function payWelcomes(pad, m, t = now()) {
  const c = cfg();
  const amt = c.welcome_amount;
  if (!(amt > 0) || !isLive() || t >= pad.ends) return 0;
  let paidHere = (await getQuery("SELECT COUNT(*) AS n FROM launchpad_welcomes WHERE room_id = ? AND state = 'paid'", [pad.id]))[0].n;
  let n = 0;
  for (const p of m.people) {
    if (paidHere >= c.welcome_per_pad) break;
    const uid = p.userIds.slice().sort()[0];
    const had = await getQuery(`SELECT user_id FROM launchpad_welcomes WHERE user_id IN (${p.userIds.map(() => "?").join(",")})`, p.userIds);
    if (had.length) continue;
    // one per PERSON: an account sharing a strong identity key with one that already got a welcome
    const ks = new Set();
    for (const id of p.userIds) for (const k of m.welcomeKeys.get(id) || []) ks.add(k);
    if (ks.size) {
      let dup = [];
      try {
        dup = await getQuery(`SELECT w.user_id FROM launchpad_welcomes w JOIN welcome_keys k ON k.userId = w.user_id
          WHERE w.state = 'paid' AND k.k IN (${[...ks].map(() => "?").join(",")}) LIMIT 1`, [...ks]);
      } catch (e) { dup = []; }
      if (dup.length) {
        await runQuery("INSERT OR IGNORE INTO launchpad_welcomes (user_id, room_id, amount, state, reason, created) VALUES (?, ?, 0, 'dup', ?, ?)",
          [uid, pad.id, `same person as ${dup[0].user_id}`, t]);
        continue;
      }
    }
    if ((await welcomeRoom()) < amt) break;                // the budget can't cover it now: try again next evaluation
    const res = await require("./mainstage")._tx(async () => {
      const ins = await runQuery("INSERT OR IGNORE INTO launchpad_welcomes (user_id, room_id, amount, state, created) VALUES (?, ?, ?, 'paid', ?)",
        [uid, pad.id, amt, t]);
      if (!ins || ins.changes !== 1) return null;
      const r = await require("./ledger").postOrThrow(uid, amt, `🚀 Pad welcome: p/${pad.slug}`.slice(0, 120),
        { transactionId: "lpw-" + uid, source: "launchpad" });
      await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
        ["lpw-" + uid, "incentives:launchpad_welcome", r.userId, `launchpad welcome p/${pad.slug}`.slice(0, 120), amt]);
      return r;
    }).catch((e) => { console.error("[launchpad] welcome:", e.message); return null; });
    if (!res) continue;
    n++; paidHere++;
    try {
      await require("./inbox").addSafe(res.userId, { kind: "system", title: `🚀 Welcome to p/${pad.slug}: PAT ${amt.toLocaleString("en-US")}`,
        body: "A new pad on the launchpad - here's a little PAT to get you going there. One welcome per person.", link: `/p/${encodeURIComponent(pad.slug)}`,
        ref: `lpw:${res.userId}` });
    } catch (e) { /* a notice never blocks */ }
  }
  if (n) console.log(`[launchpad] ${pad.id}: ${n} newcomer welcome(s) of ${amt}`);
  return n;
}

// ── the evaluation (every EVAL_MS while the launchpad is on) ──
let creditCache = new Map();
let evaluating = null;
function evaluate(t = now()) {
  if (evaluating) return evaluating;
  evaluating = (async () => {
    await init();
    if (!isOn()) { creditCache = new Map(); return { pads: 0 }; }
    const c = cfg();
    const pads = await launchPads(t);
    const credits = new Map();
    let made = 0, welcomed = 0;
    for (const pad of pads) {
      if (c.boost_credit_pat > 0 && t >= pad.start && t < pad.start + c.boost_days * DAY) credits.set(pad.id, c.boost_credit_pat);
      if (!pad.open) continue;
      const m = await metrics(pad, t, { fresh: true });
      made += (await recordGrads(pad, m, t)).length;
      welcomed += await payWelcomes(pad, m, t);
    }
    creditCache = credits;
    return { pads: pads.length, grads: made, welcomes: welcomed };
  })().finally(() => { evaluating = null; });
  return evaluating;
}
/** boosts.activeMap({credits: true}): room id -> virtual active boost PAT (no PAT behind it). */
function boostCredits() { return isOn() ? creditCache : new Map(); }

// ── views ──
async function padView(R, viewer, t = now()) {
  await init();
  const c = cfg();
  const s = state();
  const pads = await launchPads(t);
  const pad = pads.find((p) => p.id === R.id);
  const rows = await grads(R.id);
  const isOwner = !!(viewer && R.owner && R.owner.userId === viewer.userId);
  const staff = !!(viewer && (viewer.class === "Admin" || viewer.class === "Staff"));
  const base = { ok: true, on: !!s, live: isLive(), room_vaults: !!(s && s.room_vaults), launch: null };
  if (!s || !pad) return Object.assign(base, { eligible: false });
  const m = await metrics(pad, t);
  const paidTiers = new Set(rows.filter((r) => r.state === "paid").map((r) => r.tier));
  const tiers = c.tiers.map((tr, i) => {
    const g = rows.find((r) => r.tier === i + 1);
    return { n: i + 1, regulars: tr[0], active_days: tr[1], grant: tr[2], reached: m.reached.includes(i + 1) || !!g,
             state: g ? g.state : null, paid: g && g.state === "paid" ? g.paid_amount : null };
  });
  const next = tiers.find((x) => !x.reached) || null;
  const graduated = paidTiers.has(c.tiers.length) || !!rows.find((r) => r.tier === c.tiers.length && r.state === "approved");
  const out = Object.assign(base, {
    eligible: true,
    launch: { start: pad.start, ends: pad.ends, open: pad.open, days_left: Math.max(0, Math.ceil((pad.ends - t) / DAY)), window_days: c.window_days },
    progress: { regulars: m.regulars, active_days: m.active_days, next, goal: c.tiers[c.tiers.length - 1][0] },
    metrics: { chatters: m.chatters, mic_min: m.mic_min, posts: m.posts, comments: m.comments, returning: m.returning },
    tiers, graduated,
    boost: { until: pad.start + c.boost_days * DAY, active: t < pad.start + c.boost_days * DAY && c.boost_credit_pat > 0, pat: c.boost_credit_pat },
    welcome: { amount: c.welcome_amount, open: pad.open && c.welcome_amount > 0 },
    rules: { regular_days: c.regular_days, min_account_days: c.min_account_days, min_level: c.min_level, active_day_people: c.active_day_people },
  });
  if (isOwner || staff) {
    const w = (await getQuery("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS t FROM launchpad_welcomes WHERE room_id = ? AND state = 'paid'", [R.id]))[0];
    out.owner = { excluded: m.excluded, welcomes: { n: w.n, total: w.t, cap: c.welcome_per_pad },
      match: { used: (s.matched || {})[R.id] || 0, cap: c.match_cap, ratio_pct: c.match_ratio_pct, until: pad.start + c.match_days * DAY,
               open: t < pad.start + c.match_days * DAY, needs_room_vaults: !s.room_vaults, camfrog: R.platform === "camfrog" },
      grads: rows.map((r) => ({ tier: r.tier, state: r.state, amount: r.amount, paid: r.paid_amount, reason: r.reason, created: r.created })),
      review: c.review };
  }
  return out;
}

async function noteVisit(R, userId, t = now()) {
  if (!userId || !isOn()) return false;
  const pads = await launchPads(t);
  const pad = pads.find((p) => p.id === R.id && p.open);
  if (!pad) return false;
  const r = await runQuery("INSERT OR IGNORE INTO launchpad_visits (room_id, user_id, day) VALUES (?, ?, ?)", [R.id, String(userId), day(t)]);
  return !!(r && r.changes);
}

async function adminView(t = now()) {
  await init();
  const s = state();
  const pads = await launchPads(t);
  const out = [];
  for (const pad of pads) {
    const m = pad.open ? await metrics(pad, t) : null;
    out.push({ id: pad.id, slug: pad.slug, title: pad.title, platform: pad.platform, owner: pad.owner && pad.owner.username, start: pad.start,
               ends: pad.ends, open: pad.open, enrolled: pad.enrolled, regulars: m ? m.regulars : null, active_days: m ? m.active_days : null,
               excluded: m ? m.excluded : null, matched: s ? (s.matched || {})[pad.id] || 0 : 0 });
  }
  const g = await getQuery(`SELECT g.*, r.slug, r.title FROM launchpad_grads g LEFT JOIN rooms_registry r ON r.room_id = g.room_id
    ORDER BY CASE g.state WHEN 'review' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, g.id DESC LIMIT 100`);
  const w = (await getQuery("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS t FROM launchpad_welcomes WHERE state = 'paid'"))[0];
  const en = await getQuery("SELECT * FROM launchpad_pads ORDER BY updated DESC LIMIT 50");
  return { ok: true, on: !!s, live: isLive(), state: s, cfg: cfg(), pads: out,
           grads: g.map((r) => Object.assign({}, r, { metrics: (() => { try { return JSON.parse(r.metrics); } catch (e) { return null; } })() })),
           welcomes: { n: w.n, total: w.t }, enrollments: en, welcome_room: await welcomeRoom() };
}

async function decide(id, action, reason, actor) {
  await init();
  const g = (await getQuery("SELECT * FROM launchpad_grads WHERE id = ?", [int(id)]))[0];
  if (!g) throw new Refuse(404, "No such graduation.");
  if (g.state === "paid" || g.state === "refused") throw new Refuse(409, `Already ${g.state}.`);
  if (action === "approve") {
    if (g.state === "approved") return g;
    await runQuery("UPDATE launchpad_grads SET state = 'approved', decided = ?, decided_by = ?, reason = ? WHERE id = ? AND state IN ('review', 'rejected')",
      [now(), String(actor || "").slice(0, 40), reason ? String(reason).slice(0, 200) : null, g.id]);
  } else if (action === "reject") {
    await runQuery("UPDATE launchpad_grads SET state = 'rejected', decided = ?, decided_by = ?, reason = ? WHERE id = ? AND state IN ('review', 'approved')",
      [now(), String(actor || "").slice(0, 40), String(reason || "rejected by an admin").slice(0, 200), g.id]);
  } else throw new Refuse(400, "approve or reject");
  try { await require("./rooms").event(g.room_id, "launchpad-" + action, actor, `tier ${g.tier} ${g.amount}${reason ? ": " + reason : ""}`); } catch (e) { /* audit */ }
  return (await getQuery("SELECT * FROM launchpad_grads WHERE id = ?", [g.id]))[0];
}

async function setPad(roomId, action, actor, note) {
  await init();
  const R = await require("./rooms").get(roomId);
  if (!R) throw new Refuse(404, "No such pad.");
  if (R.house || R.profile || !PLATFORMS.has(R.platform)) throw new Refuse(400, "House, profile and Discord pads can't launch.");
  const t = now();
  if (action === "enroll") {
    await runQuery(`INSERT INTO launchpad_pads (room_id, enrolled_at, enrolled_by, excluded, note, updated) VALUES (?, ?, ?, 0, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET enrolled_at = excluded.enrolled_at, enrolled_by = excluded.enrolled_by, excluded = 0, note = excluded.note, updated = excluded.updated`,
      [R.id, t, String(actor || "").slice(0, 40), note ? String(note).slice(0, 200) : null, t]);
  } else if (action === "exclude" || action === "include") {
    await runQuery(`INSERT INTO launchpad_pads (room_id, excluded, enrolled_by, note, updated) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET excluded = excluded.excluded, note = COALESCE(excluded.note, note), updated = excluded.updated`,
      [R.id, action === "exclude" ? 1 : 0, String(actor || "").slice(0, 40), note ? String(note).slice(0, 200) : null, t]);
  } else throw new Refuse(400, "enroll, exclude or include");
  mcache.delete(R.id);
  try { await require("./rooms").event(R.id, "launchpad-" + action, actor, note || ""); } catch (e) { /* audit */ }
  return (await getQuery("SELECT * FROM launchpad_pads WHERE room_id = ?", [R.id]))[0];
}

// ── Pepe ──
async function pending(t = now()) {
  await init();
  const pads = await launchPads(t);
  const g = await getQuery("SELECT id, room_id, tier, amount, decided_by FROM launchpad_grads WHERE state = 'approved' ORDER BY id LIMIT 100");
  const want = new Set(g.map((x) => x.room_id));
  return { ok: true, grants: g.map((x) => ({ id: x.id, room_id: x.room_id, tier: x.tier, amount: x.amount, approved_by: x.decided_by })),
           pads: pads.filter((p) => p.open || want.has(p.id) || t < p.start + cfg().match_days * DAY).map((p) => ({ room_id: p.id, launch_start: p.start,
             owner_camfrog: p.owner && p.owner.camfrog ? String(p.owner.camfrog).toLowerCase() : "", title: p.title, platform: p.platform })) };
}
async function markPaid(b) {
  await init();
  const id = int(b.id), tier = int(b.tier);
  const st = b.state === "paid" ? "paid" : b.state === "refused" ? "refused" : null;
  if (!id || !st) throw new Refuse(400, "bad mark");
  const g = (await getQuery("SELECT * FROM launchpad_grads WHERE id = ?", [id]))[0];
  if (!g || g.room_id !== String(b.room_id || "") || g.tier !== tier) throw new Refuse(404, "no such graduation");
  if (g.state === st && (st !== "paid" || g.paid_amount === int(b.amount))) return { dup: true };
  // money moved in Pepe: "paid" wins over anything (even an admin's late reject)
  await runQuery("UPDATE launchpad_grads SET state = ?, paid_amount = ?, tid = ?, paid_at = ?, reason = COALESCE(?, reason) WHERE id = ?",
    [st, st === "paid" ? int(b.amount) : 0, String(b.tid || "").slice(0, 120), now(), b.reason ? String(b.reason).slice(0, 200) : null, id]);
  if (st === "paid") {
    try {
      const R = await require("./rooms").get(g.room_id);
      if (R && R.owner) await require("./rooms").notify(R.owner.userId, { kind: "system", title: `🚀 Launch grant paid: PAT ${int(b.amount).toLocaleString("en-US")}`,
        body: `Tier ${tier} of the launchpad - it's in p/${R.slug}'s room vault now.`, link: `/p/${encodeURIComponent(R.slug)}?tab=about`, ref: `lppaid:${id}` });
    } catch (e) { /* a notice never blocks */ }
  }
  mcache.delete(g.room_id);
  return { dup: false };
}

// ── routes ──
function register(app, { addUser, isBotToken }) {
  init().catch((e) => console.error("[launchpad] init:", e.message));
  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[launchpad]", e);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
  };
  const resolve = (slug) => require("./roomsweb").resolveRoom(slug);
  const admin = async (req) => {
    if (!req.user || !req.user.userId) return false;
    const u = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]))[0];
    return !!(u && u.class === "Admin");
  };
  const same = (req) => { try { return require("./middleware/authGuard").sameSite(req); } catch (e) { return true; } };
  app.get("/api/rooms/:slug/launch", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const R = await resolve(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      let viewer = null;
      if (req.user && req.user.userId) {
        viewer = (await getQuery("SELECT userId, class FROM users WHERE userId = ?", [req.user.userId]))[0] || null;
        if (viewer) await noteVisit(R, viewer.userId).catch(() => {});
      }
      res.json(await padView(R, viewer));
    } catch (e) { fail(res, e); }
  });
  app.get("/api/admin/launchpad", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!(await admin(req))) throw new Refuse(403, "Admins only.");
      res.json(await adminView());
    } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/launchpad/grad", addUser, async (req, res) => {
    try {
      if (!same(req)) throw new Refuse(403, "cross-site request refused");
      if (!(await admin(req))) throw new Refuse(403, "Admins only.");
      const b = req.body || {};
      const u = (await getQuery("SELECT username FROM users WHERE userId = ?", [req.user.userId]))[0];
      res.json({ ok: true, grad: await decide(b.id, String(b.action || ""), b.reason, u ? u.username : req.user.userId) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/launchpad/pad", addUser, async (req, res) => {
    try {
      if (!same(req)) throw new Refuse(403, "cross-site request refused");
      if (!(await admin(req))) throw new Refuse(403, "Admins only.");
      const b = req.body || {};
      const R = (await resolve(String(b.room || ""))) || (await require("./rooms").get(String(b.room || "")));
      if (!R) throw new Refuse(404, "No such pad.");
      const u = (await getQuery("SELECT username FROM users WHERE userId = ?", [req.user.userId]))[0];
      res.json({ ok: true, pad: await setPad(R.id, String(b.action || ""), u ? u.username : req.user.userId, b.note) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/g/launchpad/pending", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
    try { res.json(await pending()); } catch (e) { fail(res, e); }
  });
  app.post("/api/g/launchpad/paid", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ error: "unauthorized" });
    try { res.json({ ok: true, ...(await markPaid(b)) }); } catch (e) { fail(res, e); }
  });
  if (process.env.NODE_ENV !== "test") {
    const run = () => { evaluate().catch((e) => console.error("[launchpad] evaluate:", e.message)); };
    const timer = setInterval(run, EVAL_MS);
    if (timer.unref) timer.unref();
    const first = setTimeout(run, 45 * 1000);          // after Pepe's first funding sync
    if (first.unref) first.unref();
  }
}

module.exports = {
  init, register, cleanState, cleanCfg, cleanTiers, state, isOn, isLive, cfg, launchPads, metrics, recordGrads, payWelcomes, evaluate,
  boostCredits, padView, noteVisit, adminView, decide, setPad, pending, markPaid, clusters, disqualify, welcomeRoom, DEFAULTS, Refuse,
  _setClock: (fn) => { clock = fn || (() => Date.now()); mcache.clear(); },
  _reset: () => { mcache.clear(); creditCache = new Map(); UCOLS = null; },
};
