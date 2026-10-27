// micrec.js — mic recordings on the site (owner answers 2026-10-27; the plan + the wire: the ops plan mic-audio-retention-2026-10-27 §7).
//
// Pepe records every mic-up he hears (Opus, kept on PATV's own storage) and deletes them by the pad's tier (camfrog-bot
// pepe_retention.py). The site holds none of that audio. What lives here:
//
//   1. The policy switch `micrec.policy` (ships OFF; /admin/bridge "Mic recordings", capability chatlog.admin). The privacy policy has
//      never disclosed mic audio; the owner approves the text first (§8 of the plan). While it is OFF the privacy policy and the
//      account pages read as before. ON: chatlog.policy() words the "How long" line with the audio windows (merged with chat /
//      transcripts where they're equal), account deletion offers "Also delete my mic recordings" and Download my data offers "Mic
//      recordings" (each also needs Pepe's release that does it - pepeCan), the privacy page's "Last updated" becomes the day it was
//      first switched on (privacyCopy, like the chat archive's notice), and the owner sync tells Pepe (retention_keep.policy). It
//      can't be turned on while Pepe doesn't apply the owner's windows (his report: audio_* + split on - bot 1.99afq
//      `!retention split on`). Every flip is a room_events row ("micrec.switch"). (Review: /premium's NEW recordings wording - the
//      audio windows, "and 30 days after" - is behind it too (premiumperks.js); with Pepe's split on and the switch off the perk
//      names chat logs and mic transcripts only - no recordings claim, old or new.)
//   2. The owner sync's `retention_keep` block (keepBlock; POST /api/rooms/owners answer - roomsweb.js; read by the bot's
//      pepe_retention.parse_keep): legal holds (rooms, people), open reports on 🎙 lines and each room's tier lapses still inside
//      their own 30-day grace (the site's subscriptions + the chat archive's tier tracking, the latest loss of each tier). `ok` is
//      true only when every part was read in full - Pepe deletes nothing without a complete block from the last hour.
//   3. Account deletion's "Also delete my mic recordings" (accountdelete.js stores the choice; recWindowsOf / queueRecDeletes /
//      retryRecDeletes here): one website action "privacy.recdelete" [before (unix s)] per Camfrog login the account had (bot
//      pepe_mydata: the login's recordings made before then, holds kept); re-asked every 6 hours for 30 days until Pepe takes it.
//
//   micrec_meta   key PK, value (JSON): "policy" = {on, at, first_on, by}
//
// Review fixes (1.99afr):
//   * earlierHolder(uid, login): did ANOTHER PATV account hold the login before (its login history - an account merged into this
//     one is the same holder, account_merges / account_merge_log - or a deleted account's marker)? Pepe keeps his data under the
//     login from all time and can't be asked for a span, so Download my data leaves his part out for such a login (accountexport),
//     as account deletion skips it (askable).
//   * login markers (micrec_login_gone): account deletion pseudonymises the login history, so it records, for every Camfrog login
//     the deleted account had, a KEYED hash (HMAC with a random key kept only in this database - never the login) and when it was
//     let go. Only earlierHolder reads them: a later holder of that name never gets the deleted account's recordings, PMs or notes.
//     They are kept while Pepe may still hold data under the name - with no way to ask him, that's for good (the ops plan 8.5 says
//     so in the policy draft); they go once Pepe can be asked for a holder's span.
//   * a skipped login (another account held it before) keeps {login, from, to} in account_deletions.rec_skipped - admins only
//     (chatlog.admin, the card), until an admin marks it handled or REC_GIVE_UP_MS after the deletion; the card lists it to act on.
//   * Pepe "took it" only when his FOLLOW-UP came (the action's message isn't his first "queued" answer); a deletion given up keeps
//     no login (rec_windows NULLed, its actions scrubbed); a done one's action messages name the pseudonym, not the login.
//   micrec_login_gone  h PK (hex, keyed), at (ms: when it was let go);   micrec_login_key  k PK ('key'), v (the HMAC key, random)
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const DAY = 86400000;
const GRACE_MS = 30 * DAY;                 // a lapsed tier keeps its windows this long (= chatlogview.DOWNGRADE_GRACE_MS)
const KEEP_CACHE_MS = 60e3;                // the keep block is rebuilt at most once a minute (Pepe syncs every ~30 s)
const HELD_WHO_MAX = 2000;
const REPORTED_MAX = 20000;
const REC_KIND = "privacy.recdelete";        // bot 1.99afq pepe_mydata._md_web_recdelete
const REC_RETRY_MS = 6 * 3600e3;           // a failed / expired deletion is asked again after this ...
const REC_GIVE_UP_MS = 30 * DAY;           // ... for this long after the account was deleted (then the admin card shows it)
const TIER_RANK = Object.freeze({ standard: 0, prime: 1, unlimited: 2 });
const SUB_TIER = Object.freeze({ prime_plus: "unlimited", prime_time: "prime" });
const LOGIN_RE = /^[\w.\-$]{1,40}$/;

let clock = () => Date.now();
const now = () => clock();
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
class Refuse extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; this.refuse = true; } }

let CFG = { on: false, at: null, first_on: null, by: null };
let SALT = null;
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS micrec_meta (key TEXT PRIMARY KEY, value TEXT)");
      // (the markers' key lives beside them, not in micrec_meta - staging keeps its own micrec_meta but copies these from prod)
      await runQuery("CREATE TABLE IF NOT EXISTS micrec_login_gone (h TEXT PRIMARY KEY, at INTEGER)");
      await runQuery("CREATE TABLE IF NOT EXISTS micrec_login_key (k TEXT PRIMARY KEY, v TEXT)");
      await runQuery("INSERT OR IGNORE INTO micrec_login_key (k, v) VALUES ('key', ?)", [crypto.randomBytes(32).toString("hex")]);
      SALT = (await getQuery("SELECT v FROM micrec_login_key WHERE k = 'key'"))[0].v;
      await loadCfg();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
function cleanCfg(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const ms = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : null);
  return { on: c.on === true, at: ms(c.at), first_on: ms(c.first_on), by: c.by ? String(c.by).slice(0, 40) : null };
}
async function loadCfg() {
  let raw = null;
  try { raw = JSON.parse(((await getQuery("SELECT value FROM micrec_meta WHERE key = 'policy'"))[0] || {}).value || "null"); } catch (e) { raw = null; }
  CFG = cleanCfg(raw);
  return CFG;
}
/** The switch: is the mic-recordings policy text live? (sync; OFF until init has loaded it) */
const policyOn = () => !!CFG.on;
/** Is Pepe's running release the one that deletes / exports a person's recordings (website actions privacy.recdelete /
 *  privacy.export - bot 1.99afq)? That release is the one that reports the audio windows (premium audio_reported); an older Pepe
 *  never does, so nothing is queued for him that he can't do. (sync) */
function pepeCan() {
  try { return !!require("./premium").retention().audio_reported; } catch (e) { return false; }
}
const cfg = () => ({ ...CFG });

/** Flip the switch (an admin on /admin/bridge). -> cfg. Audited (room_events "micrec.switch"). */
async function setPolicy(on, actor = null) {
  await init();
  const want = on === true || on === "true" || on === 1 || on === "1" || on === "on";
  if (CFG.on === want) return { cfg: cfg(), unchanged: true };
  // never ON while Pepe doesn't apply the owner's windows: an older bot (no audio windows in his report), or his split rule still
  // off (`!retention split on` - recordings then follow the transcript windows): the text would state windows he doesn't keep
  if (want) {
    let R = null;
    try { R = require("./premium").retention(); } catch (e) { R = null; }
    if (!R || !R.audio_reported) throw new Refuse(409, "Pepe doesn't report the mic recording windows yet (his release with them isn't live) - the policy text would state windows he doesn't keep.", "audio_unreported");
    if (!R.split) throw new Refuse(409, "Pepe's split rule is still off (!retention split on): recordings still follow the transcript windows, so the policy text would state windows he doesn't keep.", "split_off");
  }
  const t = now();
  const next = cleanCfg({ on: want, at: t, first_on: CFG.first_on || (want ? t : null), by: actor });
  await runQuery("INSERT INTO micrec_meta (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
  CFG = next;
  keepCache = null;                                   // the next owner sync carries the new `policy`
  try { await require("./rooms").event(null, "micrec.switch", actor || null, `policy ${want ? "on" : "off"}`); } catch (e) { /* audit is best effort */ }
  console.log(`[micrec] policy switch ${want ? "ON" : "OFF"} (${actor || "?"})`);
  return { cfg: cfg() };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayText = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
/** views/privacy.ejs (terms.js): null while the switch is off; else {on_at, on_day, ret} - the day it was FIRST switched on (the
 *  page's "Last updated"; a later off / on doesn't re-date it) and Pepe's audio windows in words. Never throws. */
async function privacyCopy() {
  try { await init(); } catch (e) { return null; }
  if (!policyOn()) return null;
  const at = CFG.first_on || CFG.at;
  let R = null;
  try { R = require("./premium").retention(); } catch (e) { R = null; }
  const w = (v) => (v == null ? "kept for good" : `${v} days`);
  return { on_at: at, on_day: at ? dayText(at) : null,
           ret: R ? { audio_free: w(R.audio_days), audio_prime: w(R.audio_prime), audio_plus: w(R.audio_plus) } : null };
}

/**
 * The "How long" phrases per tier (chatlog.policy -> views/privacy.ejs), equal windows merged:
 * {free: "chat, mic transcripts and mic recordings 30 days", prime: "chat and mic transcripts kept for good, mic recordings 180 days",
 *  plus: "chat, mic transcripts and mic recordings kept for good"}. R = premium.retention().
 */
function howLong(R) {
  const words = (v) => (v == null ? "kept for good" : `${v} days`);
  const list = (xs) => (xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);
  const phrase = (chat, rec, audio) => {
    const groups = [];
    for (const [label, v] of [["chat", chat], ["mic transcripts", rec], ["mic recordings", audio]]) {
      const key = v == null ? "null" : String(Number(v));
      const g = groups.find((x) => x.key === key);
      if (g) g.labels.push(label); else groups.push({ key, v, labels: [label] });
    }
    return groups.map((g) => `${list(g.labels)} ${words(g.v)}`).join(", ");
  };
  const r = R || {};
  return { free: phrase(r.chat_days, r.rec_days, r.audio_days), prime: phrase(r.chat_prime, r.rec_prime, r.audio_prime),
           plus: phrase(r.chat_plus, r.rec_plus, r.audio_plus) };
}

// ── the owner sync's retention_keep block ──
const tableThere = async (t) => (await getQuery("SELECT 1 FROM pragma_table_info(?) LIMIT 1", [t]).catch(() => [])).length > 0;
const hashOf = (login) => require("./chatlog").hash(login);

/**
 * Each room's tier lapses still inside their own 30-day grace at t that rank above its tier now: Map(room id -> {tier: the tier now
 * (unlimited | prime | standard), lapsed: Map(tier -> when it was lost, ms)}). Two sources, the later loss of each tier wins (its
 * grace ends later): the pad subscriptions (a tier is lost when its paid / comped time and renewal grace ran out - premium.endsAt)
 * and the chat archive's tier tracking (chatlogview lapses: when the site saw the downgrade). Throws when the subscriptions can't
 * be read (the block is then incomplete).
 */
async function lapseMap(t = now()) {
  const P = require("./premium");
  await P.init();
  const out = new Map();
  const tierNow = (room) => { try { const x = P.padPerks(room).retention; return TIER_RANK[x] != null ? x : "standard"; } catch (e) { return "standard"; } };
  const add = (room, tier, at) => {
    if (!room || TIER_RANK[tier] == null || !(at > 0) || at > t || t - at >= GRACE_MS) return;
    const cur = tierNow(room);
    if (TIER_RANK[tier] <= TIER_RANK[cur]) return;
    if (!out.has(room)) out.set(room, { tier: cur, lapsed: new Map() });
    const m = out.get(room).lapsed;
    if (!(m.get(tier) >= at)) m.set(tier, at);
  };
  for (const s of await getQuery("SELECT * FROM premium_subs WHERE tier IN ('prime_time','prime_plus')")) {
    const ends = P.endsAt(s, t);
    if (!(ends > 0) || ends === Infinity || ends > t) continue;          // still on (or never on)
    add(String(s.target), SUB_TIER[s.tier], ends);
  }
  try {
    const CV = require("./chatlogview");
    await CV.init();
    for (const r of await getQuery("SELECT room_id FROM chatlog_rooms").catch(() => [])) {
      const T = CV.tierOf(r.room_id);
      if (!T) continue;
      for (const e of CV.graceOf(T, t)) add(String(r.room_id), e.tier, e.at);
    }
  } catch (e) { /* no archive tracking here: the subscriptions alone */ }
  return out;
}

let keepCache = null;                      // {at, block}
let keepStats = null;                      // the admin card: the last block's counts (no names)
/**
 * The owner sync's `retention_keep` block (the wire: plan §7.2 B). Never throws: a part that can't be read makes it
 * complete: false (Pepe then deletes no audio).
 */
async function keepBlock({ t = now(), fresh = false } = {}) {
  if (!fresh && keepCache && t - keepCache.at < KEEP_CACHE_MS && t >= keepCache.at) return keepCache.block;
  let complete = true;
  const block = { ok: false, v: 1, at: Math.floor(t / 1000), complete: true, policy: false, held_rooms: [], held_who_h: [], reported_tx: {}, tiers: {} };
  try { await init(); block.policy = policyOn(); } catch (e) { complete = false; }
  // 1. the tier lapses inside their grace (bot: tiers {room: {tier, lapsed: [{tier, at (ms)}]}} - Pepe's own record covers the rest)
  try {
    for (const [room, rec] of await lapseMap(t)) {
      block.tiers[room] = { tier: rec.tier, lapsed: [...rec.lapsed].sort((a, b) => TIER_RANK[b[0]] - TIER_RANK[a[0]]).map(([tier, at]) => ({ tier, at })) };
    }
  } catch (e) { complete = false; console.error("[micrec] keep block - tiers:", e.message); }
  // 2. legal holds (chatlog_holds "room:<rk>" | "who:<login or u:id>")
  try {
    await require("./chatlog").init();
    if (await tableThere("chatlog_holds")) {
      const rks = [], who = new Set();
      for (const r of await getQuery("SELECT key FROM chatlog_holds")) {
        const k = String(r.key || "");
        if (k.startsWith("room:")) rks.push(Number(k.slice(5)));
        else if (k.startsWith("who:")) {
          const w = low(k.slice(4));
          if (w.startsWith("u:")) {
            const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [w.slice(2)]).catch(() => []))[0];
            const l = low(u && u.camfrogUsername);
            if (LOGIN_RE.test(l)) who.add(hashOf(l));
          } else if (w.startsWith("h:")) {
            if (/^h:[0-9a-f]{20}$/.test(w)) who.add(w.slice(2));
          } else if (w) who.add(hashOf(w));
        }
      }
      if (rks.length) {
        for (const r of await getQuery(`SELECT room_id FROM chatlog_rooms WHERE rk IN (${rks.map(() => "?").join(",")})`, rks)) block.held_rooms.push(String(r.room_id));
        if (block.held_rooms.length < new Set(rks).size) complete = false;   // a hold whose room can't be named
      }
      const list = [...who];
      if (list.length > HELD_WHO_MAX) complete = false;
      block.held_who_h = list.slice(0, HELD_WHO_MAX);
    }
  } catch (e) { complete = false; console.error("[micrec] keep block - holds:", e.message); }
  // 3. open reports on 🎙 lines (chat_log k = 'tx'): when it was said + who said it (hashed)
  try {
    if ((await tableThere("chatlog_reports")) && (await tableThere("chat_log"))) {
      const rows = await getQuery(`SELECT DISTINCT l.c, l.ts, l.who, r2.room_id FROM chatlog_reports r JOIN chat_log l ON l.c = r.c
                                   JOIN chatlog_rooms r2 ON r2.rk = l.rk WHERE r.state = 'open' AND l.k = 'tx' ORDER BY l.ts DESC LIMIT ?`, [REPORTED_MAX + 1]);
      if (rows.length > REPORTED_MAX) complete = false;
      for (const r of rows.slice(0, REPORTED_MAX)) {
        const w = low(r.who);
        const h = /^h:[0-9a-f]{20}$/.test(w) ? w.slice(2) : LOGIN_RE.test(w) ? hashOf(w) : null;
        if (!h) continue;                                 // a web line (u:<id>) has no recording
        (block.reported_tx[r.room_id] = block.reported_tx[r.room_id] || []).push([Math.floor(Number(r.ts) / 1000), h]);
      }
    }
  } catch (e) { complete = false; console.error("[micrec] keep block - reports:", e.message); }
  block.complete = complete;
  block.ok = complete;                                    // the bot reads only a block with ok: true (else he deletes nothing)
  keepCache = { at: t, block };
  keepStats = { at: t, complete, grace_rooms: Object.keys(block.tiers).length, held_rooms: block.held_rooms.length,
                held_people: block.held_who_h.length, reported_lines: Object.values(block.reported_tx).reduce((n, l) => n + l.length, 0) };
  return block;
}

// ── who held a login: this account (and accounts merged into it), or another one ──
/** The ids that ARE this account: itself and every account merged into it (account_merges - flattened - and the older
 *  account_merge_log, followed a few hops). A merged-away account's login history is this account's own. */
async function holderIds(uid) {
  const ids = new Set([String(uid)]);
  let frontier = [String(uid)];
  for (let hop = 0; hop < 6 && frontier.length; hop++) {
    const next = [];
    for (const id of frontier) {
      const rows = [];
      if (await tableThere("account_merges")) rows.push(...(await getQuery("SELECT old_id AS id FROM account_merges WHERE new_id = ?", [id]).catch(() => [])));
      if (await tableThere("account_merge_log")) rows.push(...(await getQuery("SELECT from_id AS id FROM account_merge_log WHERE to_id = ?", [id]).catch(() => [])));
      for (const r of rows) { const x = String(r.id || ""); if (x && !ids.has(x)) { ids.add(x); next.push(x); } }
    }
    frontier = next;
  }
  return ids;
}
/** The records about a login by OTHER accounts (not uid, not one merged into it): [at (ms), ...] - login_changes, username_history
 *  kind 'camfrog' (a 'seen' row too: that account had it). */
async function othersMarks(uid, login, ids = null) {
  const mine = ids || (await holderIds(uid));
  const l = low(login);
  const out = [];
  if (await tableThere("login_changes")) {
    for (const r of await getQuery("SELECT userId, at FROM login_changes WHERE lower(old_login) = ? OR lower(new_login) = ?", [l, l])) if (!mine.has(String(r.userId))) out.push(Number(r.at) || 0);
  }
  if (await tableThere("username_history")) {
    for (const r of await getQuery("SELECT userId, at FROM username_history WHERE kind = 'camfrog' AND (lower(old_username) = ? OR lower(new_username) = ?)", [l, l])) {
      if (!mine.has(String(r.userId))) out.push(Number(r.at) || 0);
    }
  }
  return out;
}
/** The keyed hash of a login for the deletion markers (HMAC, the key random and only in this database). */
const goneHash = (login) => crypto.createHmac("sha256", String(SALT || "")).update("login-gone:" + low(login)).digest("hex").slice(0, 32);
/** INSIDE account deletion's transaction, before it pseudonymises the login history: a marker per Camfrog login the account had
 *  ([{login, at}] - at = when it was let go). -> how many were written. Needs init() first (the key). */
async function noteLoginsGone(list) {
  if (!SALT) await init();
  let n = 0;
  for (const x of list || []) {
    const l = low(x && x.login);
    if (!LOGIN_RE.test(l)) continue;
    const at = Math.floor(Number(x.at) || now());
    const r = await runQuery("INSERT INTO micrec_login_gone (h, at) VALUES (?, ?) ON CONFLICT(h) DO UPDATE SET at = MAX(at, excluded.at)", [goneHash(l), at]);
    n += (r && r.changes) || 0;
  }
  return n;
}
/**
 * Did ANOTHER PATV account hold `login` at some point (its login history, or a deleted account's marker)? The account holds the
 * login now, so another holder's time with it was before (or between this account's own spans) - and Pepe keeps everything under
 * the login from all time. -> true | false
 */
async function earlierHolder(uid, login) {
  await init();
  const l = low(login);
  if (!LOGIN_RE.test(l)) return false;
  if ((await othersMarks(uid, l)).length) return true;
  return (await getQuery("SELECT 1 FROM micrec_login_gone WHERE h = ? LIMIT 1", [goneHash(l)])).length > 0;
}

// ── account deletion: "Also delete my mic recordings" ──
/**
 * The Camfrog logins whose recordings are the account's, each with its span: [{login, from, to}] (ms; from exclusive, 0 = from the
 * start; to inclusive). From accountdelete.loginWindowsOf (read inside the deletion's transaction BEFORE it deletes the login
 * history): its login now up to `upto`, and every login it let go up to then. A recording is the Camfrog account's own (unlike a
 * web line, it doesn't depend on who held the PATV link), so each span starts at 0 - unless ANOTHER account held that login earlier:
 * then after that account's last record of it (review: an account merged into this one is this one). A login another account holds
 * now is only reached up to when this one let it go. (A deleted earlier holder's marker doesn't count here: deleting what a deleted
 * account left behind harms nobody - only an export must never hand it over.)
 */
async function recWindowsOf(uid, login, upto) {
  const AD = require("./accountdelete");
  const wins = await AD.loginWindowsOf(uid, login, upto);
  const ids = await holderIds(uid);
  const out = [];
  for (const w of wins) {
    if (!LOGIN_RE.test(w.login)) continue;
    const marks = await othersMarks(uid, w.login, ids);
    const from = marks.reduce((m, at) => (at < w.to && at > m ? at : m), 0);
    out.push({ login: w.login, from, to: w.to });
  }
  // one span per login: the widest (two records of one change can give two)
  const by = new Map();
  for (const w of out) {
    const have = by.get(w.login);
    if (!have) by.set(w.login, { ...w });
    else { have.from = Math.min(have.from, w.from); have.to = Math.max(have.to, w.to); }
  }
  return [...by.values()];
}

/** The website action's args for a span: [before] in unix seconds (bot pepe_mydata: the login's recordings made before it). */
const recArgs = (w) => JSON.stringify([String(Math.floor((Number(w.to) || 0) / 1000))]);
/** Spans Pepe can be asked to delete: the bot deletes EVERYTHING of a login before `before`, so only a login no other account held
 *  before (from 0) - an earlier holder's recordings are never deleted on this account's word (counted as skipped; by hand). */
const askable = (windows) => (windows || []).filter((w) => w && LOGIN_RE.test(String(w.login || "")) && !(Number(w.from) > 0));
/** INSIDE the deletion's transaction: one "privacy.recdelete" action per askable span (the login stays on the action until Pepe
 *  takes it). windows = askable(...) already. -> how many were queued */
async function queueRecDeletes(uid, pseudo, windows, t = now()) {
  let n = 0;
  if (!(await tableThere("pepe_actions"))) return 0;            // (no action queue here: retryRecDeletes asks once there is one)
  for (let i = 0; i < (windows || []).length; i++) {
    const w = windows[i];
    const r = await runQuery(`INSERT OR IGNORE INTO pepe_actions (user_id, username, camfrog, site_admin, kind, args, tag, label, status, created, updated, idem)
                              VALUES (?, ?, ?, 0, ?, ?, 'privacy', 'account deleted: mic recordings', 'pending', ?, ?, ?)`,
                             [String(uid), pseudo, w.login, REC_KIND, recArgs(w), t, t, `acctdel-rec-${uid}-${i}-1`]);
    n += (r && r.changes) || 0;
  }
  return n;
}

/**
 * A done deletion whose recordings Pepe hasn't deleted yet: each span's latest action failed or expired (an older Pepe, Pepe down)
 * -> asked again every REC_RETRY_MS. Review: Pepe's FIRST answer ("queued: ...") only says he journaled it - the deletion counts as
 * run once his follow-up replaced it ("deleted N mic recording file(s) ..."; a later failed follow-up -> asked again); one answered
 * "queued" with no follow-up for REC_QUEUED_MS is asked again (he merges it into the same job). All run -> rec_done_at, and the logins
 * leave the row and its actions (args / camfrog; his messages name the pseudonym). Not run REC_GIVE_UP_MS after the deletion ->
 * rec_gave_up_at (the admin card lists it; one console error) and the logins go then too - never kept beyond that. Skipped spans
 * (rec_skipped: another account held the login before) go REC_GIVE_UP_MS after the deletion, or when an admin marks them handled.
 * -> {asked, done, gave_up, skipped_expired}
 */
const REC_QUEUED_MS = DAY;
const queuedOnly = (a) => /^\s*queued\b/i.test(String(a.message || ""));
const gaveUpLogged = new Set();
/** The deletion's actions keep no login: camfrog NULL, Pepe's messages with the login -> the pseudonym, a pending one withdrawn. */
async function scrubRecActions(d, wins, why = null) {
  const logins = (wins || []).map((w) => low(w && w.login)).filter((l) => LOGIN_RE.test(l));
  for (const a of await getQuery("SELECT id, status, message FROM pepe_actions WHERE user_id = ? AND kind = ?", [String(d.user_id), REC_KIND])) {
    let msg = String(a.message || "");
    for (const l of logins) msg = msg.split(new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")).join(d.pseudonym || "deleted");
    const pend = a.status === "pending" || a.status === "claimed";
    await runQuery("UPDATE pepe_actions SET camfrog = NULL, args = '[]', message = ?, status = ?, updated = ? WHERE id = ?",
                   [pend && why ? why : msg, pend && why ? "failed" : a.status, now(), a.id]);
  }
}
async function retryRecDeletes() {
  const out = { asked: 0, done: 0, gave_up: 0, skipped_expired: 0 };
  if (!(await tableThere("pepe_actions")) || !(await tableThere("account_deletions"))) return out;
  const cols = (await getQuery("SELECT name FROM pragma_table_info('account_deletions')")).map((r) => r.name);
  if (!cols.includes("rec_windows")) return out;
  const t = now();
  for (const d of await getQuery(`SELECT id, user_id, done_at, pseudonym, rec_windows FROM account_deletions WHERE state = 'done' AND delete_recordings = 1
                                   AND rec_done_at IS NULL AND rec_gave_up_at IS NULL ORDER BY id LIMIT 50`)) {
    let wins = [];
    try { wins = JSON.parse(d.rec_windows || "[]") || []; } catch (e) { wins = []; }
    if (!Array.isArray(wins)) wins = [];
    let confirmed = 0;
    for (let i = 0; i < wins.length; i++) {
      const w = wins[i] || {};
      const acts = await getQuery(`SELECT id, status, updated, idem, message FROM pepe_actions WHERE user_id = ? AND kind = ? AND idem LIKE ? ORDER BY id`,
                                  [String(d.user_id), REC_KIND, `acctdel-rec-${d.user_id}-${i}-%`]);
      const last = acts[acts.length - 1];
      if (last && (last.status === "done" || last.status === "ok") && !queuedOnly(last)) { confirmed++; continue; }   // his follow-up
      if (acts.some((a) => a.status === "pending" || a.status === "claimed")) continue;          // Pepe has it (or will)
      if (t - Number(d.done_at || 0) > REC_GIVE_UP_MS) continue;
      if (last && t - Number(last.updated || 0) < (queuedOnly(last) && last.status !== "failed" ? REC_QUEUED_MS : REC_RETRY_MS)) continue;
      if (!LOGIN_RE.test(String(w.login || ""))) continue;
      await runQuery(`INSERT OR IGNORE INTO pepe_actions (user_id, username, camfrog, site_admin, kind, args, tag, label, status, created, updated, idem)
                      VALUES (?, ?, ?, 0, ?, ?, 'privacy', 'account deleted: mic recordings', 'pending', ?, ?, ?)`,
                     [String(d.user_id), d.pseudonym || "deleted", w.login, REC_KIND, recArgs(w), t, t, `acctdel-rec-${d.user_id}-${i}-${acts.length + 1}`]);
      out.asked++;
    }
    if (confirmed === wins.length) {
      await runQuery("UPDATE account_deletions SET rec_done_at = ?, rec_windows = NULL WHERE id = ?", [t, d.id]);
      await scrubRecActions(d, wins);
      out.done++;
    } else if (t - Number(d.done_at || 0) > REC_GIVE_UP_MS) {
      await runQuery("UPDATE account_deletions SET rec_gave_up_at = ?, rec_windows = NULL WHERE id = ?", [t, d.id]);
      await scrubRecActions(d, wins, "given up: Pepe didn't delete them in 30 days");
      if (!gaveUpLogged.has(d.id)) { gaveUpLogged.add(d.id); console.error(`[micrec] account deletion ${d.id}: Pepe never confirmed deleting its mic recordings (30 days) - see /admin/bridge#micrec`); }
      out.gave_up++;
    }
  }
  // skipped spans: kept for the admins to act on, never past REC_GIVE_UP_MS after the deletion
  if (cols.includes("rec_skipped")) {
    const r = await runQuery("UPDATE account_deletions SET rec_skipped = NULL WHERE rec_skipped IS NOT NULL AND done_at IS NOT NULL AND done_at < ?", [t - REC_GIVE_UP_MS]);
    out.skipped_expired = (r && r.changes) || 0;
  }
  return out;
}

/** The admin card: a skipped span handled by hand (or nothing to do) - the logins leave the row. Audited. -> {ok} */
async function skippedHandled(id, actor = null) {
  const r = await runQuery("UPDATE account_deletions SET rec_skipped = NULL, rec_skipped_done_at = ? WHERE id = ? AND rec_skipped IS NOT NULL", [now(), Number(id) || 0]);
  if (!r || !r.changes) throw new Refuse(404, "Nothing waits on that deletion.", "none");
  try { await require("./rooms").event(null, "micrec.skipped_done", actor || null, `deletion ${Number(id)}`); } catch (e) { /* audit is best effort */ }
  return { ok: true };
}

// ── the admin card ("Mic recordings" on /admin/bridge) ──
async function adminView() {
  await init();
  let R = null, at = null, audioAt = null;
  try { const P = require("./premium"); R = P.retention(); at = P.retentionAt(); audioAt = P.retentionAudioAt(); } catch (e) { R = null; }
  const block = await keepBlock();
  let dels = { waiting: 0, confirmed: 0, gave_up: 0, rows: [] };
  try {
    const cols = (await getQuery("SELECT name FROM pragma_table_info('account_deletions')")).map((r) => r.name);
    if (cols.includes("rec_windows")) {
      const c = (await getQuery(`SELECT SUM(CASE WHEN state = 'done' AND rec_done_at IS NULL AND rec_gave_up_at IS NULL THEN 1 ELSE 0 END) AS waiting,
                                        SUM(CASE WHEN rec_done_at IS NOT NULL THEN 1 ELSE 0 END) AS confirmed,
                                        SUM(CASE WHEN rec_gave_up_at IS NOT NULL THEN 1 ELSE 0 END) AS gave_up
                                 FROM account_deletions WHERE delete_recordings = 1`))[0] || {};
      dels = { waiting: Number(c.waiting) || 0, confirmed: Number(c.confirmed) || 0, gave_up: Number(c.gave_up) || 0,
               rows: (await getQuery(`SELECT id, pseudonym, state, execute_at, done_at, rec_done_at, rec_gave_up_at, report
                                      ${cols.includes("rec_skipped") ? ", rec_skipped, rec_skipped_done_at" : ""} FROM account_deletions
                                      WHERE delete_recordings = 1 ORDER BY id DESC LIMIT 20`)).map((r) => {
                 let rep = {}, sk = null;
                 try { rep = JSON.parse(r.report || "{}") || {}; } catch (e) { rep = {}; }
                 try { sk = r.rec_skipped ? JSON.parse(r.rec_skipped) : null; } catch (e) { sk = null; }
                 const rc = rep.recordings || {};
                 // review: a skipped span is shown WITH its login and span (admins only - chatlog.admin) so someone can act on it;
                 // it leaves the row when handled or REC_GIVE_UP_MS after the deletion
                 return { id: r.id, pseudonym: r.pseudonym, state: r.state, execute_at: r.execute_at, done_at: r.done_at, rec_done_at: r.rec_done_at,
                          rec_gave_up_at: r.rec_gave_up_at, logins: Number(rc.logins) || 0, skipped: Number(rc.skipped) || 0,
                          skipped_spans: Array.isArray(sk) ? sk.slice(0, 20).map((w) => ({ login: String(w.login || ""), from: Number(w.from) || 0, to: Number(w.to) || 0 })) : null,
                          skipped_done_at: r.rec_skipped_done_at || null };
               }) };
    }
  } catch (e) { /* no deletions table yet */ }
  let exports_ = null;
  try { exports_ = await require("./accountexport").pepeStatus(); } catch (e) { exports_ = null; }
  return { cfg: cfg(), windows: R ? { audio_days: R.audio_days, audio_prime: R.audio_prime, audio_plus: R.audio_plus, chat_days: R.chat_days,
                                      chat_prime: R.chat_prime, chat_plus: R.chat_plus, rec_days: R.rec_days, rec_prime: R.rec_prime, rec_plus: R.rec_plus } : null,
           reported_at: at, audio_reported_at: audioAt, pepe_can: pepeCan(), split: !!(R && R.split),
           keep: keepStats ? { ...keepStats, policy: block.policy } : null, deletions: dels, exports: exports_ };
}

let timer = null;
function register(app, { addUser }) {
  init().catch((e) => console.error("[micrec] init:", e.message));
  const SP = require("./siteperms");
  const guard = require("./middleware/authGuard");
  const json = require("express").json({ limit: "4kb" });
  const can = (req) => SP.can(req.user, "chatlog.admin");
  app.get("/api/admin/micrec", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    try { res.json({ ok: true, ...(await adminView()) }); }
    catch (e) { console.error("[micrec] admin:", e); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  app.post("/api/admin/micrec/switch", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    const b = req.body || {};
    if (b.name !== "policy") return res.status(400).json({ ok: false, error: "No such switch." });
    try { res.json({ ok: true, ...(await setPolicy(b.on === true, req.user.username)) }); }
    catch (e) {
      if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code });
      console.error("[micrec] switch:", e); res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
  // review: a skipped login's recordings handled by hand (or nothing to do) - its login and span leave the deletion's row
  app.post("/api/admin/micrec/skipped", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    try { res.json(await skippedHandled((req.body || {}).id, req.user.username)); }
    catch (e) {
      if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code });
      console.error("[micrec] skipped:", e); res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
  if (!timer) {
    // the 10-minute account deletion tick runs retryRecDeletes too; this reload picks up a switch flipped from the shell
    timer = setInterval(() => { loadCfg().catch(() => {}); }, 60e3);
    if (timer.unref) timer.unref();
  }
}

module.exports = { init, register, policyOn, pepeCan, setPolicy, cfg, privacyCopy, howLong, keepBlock, lapseMap, recWindowsOf, askable, queueRecDeletes, retryRecDeletes,
                   adminView, loadCfg, Refuse, REC_KIND, GRACE_MS, REC_RETRY_MS, REC_GIVE_UP_MS, HELD_WHO_MAX, REPORTED_MAX, KEEP_CACHE_MS,
                   holderIds, earlierHolder, noteLoginsGone, skippedHandled, REC_QUEUED_MS,                     // review
                   _setClock: (f) => { clock = f || (() => Date.now()); }, _resetCache: () => { keepCache = null; keepStats = null; } };
