// plexchat.js — 1.99ajk: 📼 PLEX FROM CHAT. Pepe's one bot route for "pepe play the matrix" / "!plex alien -cam" in a Camfrog room
// or a pad's web chat: search the library, start a title / an episode / a season on the pad's stage, queue it behind what's on,
// put it on Pepe's main stream (staff), the controls, what's playing.
//
// WHO: the site resolves the SPEAKER, never Pepe's typed text - {user_id} (a web chat job: the account the site put on it) or
// {login} (a proven Camfrog login -> the PATV account linked to it: users.camfrogUsername, a real account preferred over a CF auto
// one). No account, or only a CF auto account (nobody can sign in to it) -> code "link"; an archived account -> "account".
// RULES: exactly the user path's - nothing is copied here. medialib.playFor / mediaqueue.startFor are the functions the /stage
// routes (and the Room Dock) call: library access, the pad's visibility (seesPad), preflight (one library stream per pad, banned,
// own open slot, the daily cap), the pad's 📼 limit, the price / estimate the person said yes to (400 / 409 re-ask), a free
// encoder, the slot. On top, for chat: the pad's 18+ gate (padaccess.adultGate - a chat speaker never confirmed their age on the
// site for that pad). Queueing behind what's on = mediaqueue.addNext (the queue's starter, or a free queue's controllers).
// Pepe's cam = onair.libraryFor (onair.operate, on-air on, allow_library; busy -> onair_busy with what's on; next -> a ⏰ row).
// Controls = medialib / mediaqueue as that user (mayControl inside).
// PRIVACY: titles only - file paths never leave (mediactl's briefs carry none; anything named `file` is dropped anyway). Results
// only after access + the pad's visibility. "rpm" writes a private pad-chat row (roompm) for an account on a pad it sees.
//
//   POST /api/medialib/bot   {password, op, as: {login} | {user_id}, room, via: room | web, ...}
//     search    {q, year?, season?, episode?, target: stage | cam}  -> {rows (<= 5), free, how, per_hour, state, target, pad}
//     shelves   {} -> allowed genres and shelves; find {ask,raw,exclude?,limit?} -> verified rows (<=20), catalog and pricing
//               A known show's unmatched detail may return alternatives:[season rows] (<=5), never an automatic first episode.
//               One show + about (1.99amq clerkfast): a single pick's rows in the word search's order (a selection word keeps air
//               order); clear:true when exactly one of its episodes has
//               every telling word of the description (plexfind describedOnce) - the bot may answer that one without its model.
//               Clerk confirms send play {clerk:true}; this forces a fresh catalog/rating check for single keys too.
//               probe:true checks catalog titles before interpretation without an external Seerr lookup.
//     browse    find with limit 3; request {kind,tmdb,season?,target} consumes this speaker/pad's verified 10-minute offer.
//     embed_todo {model?,dim?,limit?,after?}; embed_put {model,dim,vecs} are authenticated bot-only operations with no speaker/room.
//               find accepts qvec:{model,dim,v,scale}; malformed/mismatched vectors silently retain ordinary word search.
//     play      {key, scope: title | episode | season | season_rest | series_from, target, price?, estimate?, mode: now | next | replace | queue}
//               Clerk lists also send keys:[key], scope:list|series. Every key is checked before the existing queue builder runs.
//               (1.99?? plexqueue: mode queue = /stage's "+ Add to the queue" - mediaqueue.queueFor: the END of a running queue the speaker may
//                grow, else a queue of their OWN lined up after what's on; estimate = the row's queue_cost they said yes to;
//                -> {queued, how: append | after, title, added, items, cost, per_hour, place, line, eta_sec, behind, behind_queue, behind_left}.
//                A site that answers padState without library.queue_as doesn't know it: an older one reads it as a plain play - Pepe checks first)
//               (1.99?? plexqueue review: mode queue + behind_slot = padState library.behind_slot, the title the confirm named - something else
//                on by the yes: behind_changed {playing, behind_slot}; a plain play may send secs = its length: refused busy_library / busy_queue
//                it carries the speaker's padState as state + queue_cost for those secs, so Pepe can offer queue / replace there)
//               (plexreplace: target stage + mode replace = ▶ "Play this instead" - ONE request: what's on the pad comes off, the new title
//                goes on with its feature and card - medialib.playFor / mediaqueue.startFor {replace: true}; -> + replaced {title, queue})
//     control   {action: pause | resume | stop | seek | seek_rel | next | prev, value}
//     np        {target?}                                             -> the pad's 📼 player (read-only view) + the on-air label
//     continue  {show?}                                               -> the speaker's next episode (last 14 days) as one row (1.99?? plexqueue: + queue_cost, how, pad)
//     rpm       {text}                                                -> a private "only you can see this" row for that account
//   refusals: {ok: false, code, error, price?, estimate?, label?, cap?, need?, have?, max?, by?} - code is one of CODES
"use strict";
const express = require("express");
const { getQuery } = require("./dbUtils");

const ML = () => require("./medialib");
const MQ = () => require("./mediaqueue");
const OA = () => require("./onair");
const rooms = () => require("./rooms");
const conf = () => require("./mediaconf");
const PA = () => require("./padaccess");
const CF = () => require("./plexfind");
const CAT = () => require("./plexcatalog");
const MR = () => require("./mediarequests");
const VEC = () => require("./plexvectors");

const CODES = ["signin", "off", "cap", "pad", "banned", "has_slot", "busy_library", "busy_queue", "slot_taken", "site_full", "encoder_busy",
  "encoder_down", "too_long", "price", "estimate", "pat", "control_denied", "nothing_on", "last_title", "first_title", "queue_full", "not_starter",
  "not_playing", "queue_off", "onair_off", "onair_library_off", "onair_staff", "onair_busy", "irl", "pepe_away", "rate", "link", "account", "bad",
  "not_found", "error", "replace_gone", "replace_changed", "play_changed", "clerk_off", "catalog_down", "unavailable",
  "request_off", "request_stale", "unlinked", "level", "limit", "requested", "available", "upstream", "embed_off", "embed_model", "embed_busy",
  // 1.99?? plexqueue: the line's own refusals (mediaqueue.after / preflight) - Pepe words each one
  "queue_on", "queue_held", "line_full", "line_next", "booking_next", "nothing_after",
  // ... review F8: what a line-up was to wait for isn't on any more (Pepe asks again, naming what is)
  "behind_changed"];
const OPS = new Set(["search", "find", "browse", "request", "shelves", "play", "control", "np", "continue", "rpm", "embed_todo", "embed_put"]);
const SCOPES = new Set(["title", "episode", "season", "season_rest", "series_from", "list", "series"]);
const RATE_MAX = 30, RATE_MS = 60 * 1000;
const CONTINUE_MS = 14 * 24 * 3600 * 1000;

let clock = () => Date.now();
const now = () => clock();

class Fail extends Error {
  constructor(code, message, status = 400, extra = null) { super(message); this.code = code; this.status = status; this.refuse = true; if (extra) this.extra = extra; }
}

// ── the speaker ──
async function userRow(sql, args) { try { return await getQuery(sql, args); } catch (e) { return []; } }
/** {user_id} | {login} -> {userId, username, class}. Throws Fail link | account. */
async function resolve(as) {
  const a = as && typeof as === "object" ? as : {};
  let rows = [];
  if (a.user_id != null && String(a.user_id).trim()) {
    rows = await userRow("SELECT * FROM users WHERE userId = ?", [String(a.user_id).trim().slice(0, 80)]);
  } else if (a.login != null && String(a.login).trim()) {
    const login = String(a.login).trim().toLowerCase().slice(0, 40);
    if (/^u:/.test(login)) throw new Fail("link", "Link your account first.", 403);     // an account nick is never a login
    rows = await userRow("SELECT * FROM users WHERE lower(camfrogUsername) = ? ORDER BY userId", [login]);
  } else throw new Fail("link", "Link your account first.", 403);
  const AA = require("./autoaccount");
  let pick = null;
  for (const r of rows) {
    let auto = false;
    try { auto = await AA.isAutoAccount(r.userId); } catch (e) { auto = false; }
    if (!auto) { pick = r; break; }
  }
  if (!pick) throw new Fail("link", "Plex plays run on your PATV account - link it (or sign up) first.", 403);
  if (pick.archived_at != null && pick.archived_at !== "" && pick.archived_at !== 0) throw new Fail("account", "This account can't do that.", 403);
  return { userId: String(pick.userId), username: pick.username, class: pick.class || null };
}

// ── refusals -> stable codes ──
const ALIAS = { full: "queue_full", library: "onair_library_off", staff_only: "onair_staff", when: "bad", embed_bad: "bad", owner: "onair_staff",
                gone: "not_found", adult: "pad", pad_private: "pad" };
const num = (s) => Number(String(s || "").replace(/[^\d]/g, "")) || 0;
// 1.99ajk plexchat review: only a REFUSAL (a Refuse / Fail - e.refuse) carries a code and its words to the room; anything else is a
// crash (SQLITE_BUSY, ECONNRESET, a TypeError ...) - code "error", a generic line, and its stack in the log - never its message
function codeOf(e) {
  if (!e) return "error";
  const refusal = !!(e.refuse || e instanceof Fail);
  const c = e.code || (e.extra && e.extra.code);
  if (refusal && c && typeof c === "string") {
    const k = ALIAS[c] || c;
    if (CODES.includes(k)) return k;
    if (/^[a-z][a-z_]{1,29}$/.test(k)) return k;                       // a refusal's own (newer) code: Pepe falls back to its words
  }
  const msg = String(e.message || "");
  if (!refusal) return e.status === 503 || e.status === 502 ? "encoder_down" : "error";
  if (e.status === 402) return "pat";
  if (e.status === 401) return "signin";
  if (/No such pad/i.test(msg)) return "pad";
  if (/Not in the Plex library/i.test(msg)) return "not_found";
  if (e.status === 503 || e.status === 502) return "encoder_down";
  return e.status && e.status >= 500 ? "error" : "bad";
}
function failBody(e) {
  const code = codeOf(e);
  const x = { ...(e && e.extra ? e.extra : {}) };
  const refusal = !!(e && (e.refuse || e instanceof Fail));
  const out = { ok: false, code, error: refusal && code !== "error" ? String(e.message || "Something went wrong.").slice(0, 300) : "Something went wrong." };
  for (const k of ["price", "estimate", "cap", "max", "busy", "max_minutes", "by"]) if (x[k] != null) out[k] = x[k];
  // plexreplace: a busy pad says what's on and whether this speaker may replace it (Pepe offers "play X instead?" then)
  if (x.can_replace != null) out.can_replace = !!x.can_replace;
  if (x.playing != null) out.playing = String(x.playing).slice(0, 120);
  if (x.playing_queue != null) out.playing_queue = !!x.playing_queue;
  if (x.playing_left != null) out.playing_left = Math.max(0, Math.floor(Number(x.playing_left) || 0));
  if (x.playing_slot != null) out.playing_slot = String(x.playing_slot).slice(0, 64);   // (review fix: the slot Pepe names with the yes)
  if (e && e.price != null && out.price == null) out.price = e.price;
  if (e && e.label) out.label = String(e.label).slice(0, 120);
  // 1.99?? plexqueue: a refusal's own figures (the line's "Lining it up takes X points ... and you have Y": need + balance; where it stands)
  for (const k of ["need", "place", "line"]) if (x[k] != null && Number.isFinite(Number(x[k]))) out[k] = Math.max(0, Math.floor(Number(x[k])));
  if (x.balance != null && Number.isFinite(Number(x.balance))) out.have = Math.max(0, Math.floor(Number(x.balance)));
  // ... review F8: the slot a line-up would go behind now (behind_changed); review F2: a busy plain play's padState for the speaker and what
  // queueing the title costs them - Pepe offers queue / replace on the spot (padState is titles only: never a file)
  if (typeof x.behind_slot === "string" && /^[A-Za-z0-9-]{8,64}$/.test(x.behind_slot)) out.behind_slot = x.behind_slot;
  if (x.state && typeof x.state === "object" && !Array.isArray(x.state)) out.state = x.state;
  if (x.queue_cost != null && Number.isFinite(Number(x.queue_cost))) out.queue_cost = Math.max(0, Math.floor(Number(x.queue_cost)));
  if (code === "pat" && (out.need == null || out.have == null)) {   // shop.chargeService: "That costs X PAT and you have Y."
    const m = /costs\s+([\d,.]+)\s+PAT\s+and\s+you\s+have\s+([\d,.]+)/i.exec(out.error);
    if (m) { out.need = num(m[1]); out.have = num(m[2]); }
  }
  delete out.file;
  return out;
}

// ── helpers ──
const clean = (v, n = 100) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const intOr = (v, lo, hi) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ").replace(/^(the|a|an) /, "").trim();
async function padOf(room) {
  const R = await ML()._q.roomOf(room);
  if (!R) throw new Fail("pad", "No such pad.", 404);
  return R;
}
/** The pad must be one this account may see (Approved pads: inside only) and past its 18+ gate. */
async function seeOrFail(user, R) {
  const stage = require("./mainstage");
  if (!(await stage.seesPad(user, R.id))) throw new Fail("pad", "No such pad.", 404);
  let gate = null;
  try {
    await PA().init();
    gate = PA().adultGate(user, R.id);
  } catch (e) {
    // 1.99ajk plexchat review: the 18+ check FAILS CLOSED - if it can't be asked, the pad reads as no such pad
    console.error("[plexchat] the 18+ gate couldn't be checked:", e && e.message ? e.message : e);
    gate = null;
  }
  if (gate !== "ok") throw new Fail("pad", "No such pad.", 404);
}
/** Pepe's cam from chat: Staff (onair.operate), on-air on, allow_library - the same order onair.libraryFor checks them in. */
async function camOrFail(user) {
  const SP = require("./siteperms");
  await OA().init();
  if (!SP.can(user, "onair.operate")) throw new Fail("onair_staff", "Only staff can put things on Pepe's stream.", 403);
  const C = OA().config();
  if (!C.enabled) throw new Fail("onair_off", OA().WHY.off, 409);
  if (!C.allow_library) throw new Fail("onair_library_off", OA().WHY.library, 409);
}
const slim = (r) => {
  const o = {};
  for (const k of ["key", "type", "title", "year", "show", "season", "episode", "duration", "items", "total_sec", "price", "estimate", "scope",
                   "label", "exact", "first_title", "leafs", "next_cost"]) if (r[k] !== undefined && r[k] !== null) o[k] = r[k];
  return o;
};
const labelOf = (it) => (it.type === "episode" && it.show
  ? `${it.show} S${it.season == null ? 0 : it.season}E${it.episode == null ? 0 : it.episode}${it.title ? ` "${it.title}"` : ""}`
  : `${it.title}${it.year ? ` (${it.year})` : ""}`).slice(0, 120);

/** How well a search brief matches what was asked (higher = better). */
function score(it, q, want) {
  const t = norm(it.type === "episode" ? it.show || it.title : it.title), n = norm(q);
  let s = 0;
  if (!n) s = 10;
  else if (t === n) s = 100;
  else if (t.startsWith(n) || n.startsWith(t + " ")) s = 75;          // "alien" -> Aliens / Alien: Romulus (Plex's order breaks the tie)
  else if (n.split(" ").every((w) => (" " + t + " ").includes(" " + w + " "))) s = 60;
  else if (t.includes(n)) s = 50;
  else s = 30;
  if (it.type === "episode" && norm(it.title) === n) s = Math.max(s, 70);       // an episode asked for by its own title
  if (want.year) s += Number(it.year) === want.year ? 30 : -40;
  if (want.season != null || want.episode != null) s += it.type === "show" ? 25 : it.type === "episode" ? 10 : -30;
  else if (it.type === "episode" && norm(it.title) !== n) s -= 20;
  // 1.99ajk plexchat review: "the fargo movie" / "the office show" - what the person called it
  if (want.hint === "movie") s += it.type === "movie" ? 15 : -15;
  else if (want.hint === "show") s += it.type === "movie" ? -15 : 15;
  return s;
}

// ── ops ──
function clerkOrFail(user) {
  const enabled = conf().get().clerk_enabled;
  if (enabled !== "everyone" && !(enabled === "staff" && require("./siteperms").atLeast(user, "staff"))) throw new Fail("clerk_off", "The clerk is switched off here.", 403);
}
async function clerkAccess(user, b) {
  const target = b.target === "cam" ? "cam" : "stage";
  const R = target === "cam" ? await padOf(rooms().HOUSE_ROOM) : await padOf(b.room);
  await seeOrFail(user, R);
  if (target === "cam") await camOrFail(user);
  await ML().init();
  const A = await ML()._q.mustAccess(user);
  clerkOrFail(user);
  return { target, R, A };
}
async function opShelves(user, b) {
  await clerkAccess(user, b);
  const out = typeof CF().shelves === "function" ? await CF().shelves() : await CAT().shelves();
  if ([true, "true", "1", 1].includes(conf().get().clerk_embed)) {
    // plexvectors 1.99amg: a person's ask takes the quick look - the stored model and the last numbers, never a catalog count
    try { out.embed = await VEC().status({ quick: true }); }
    catch (_) { out.embed = { enabled: true, ready: false, model: null, dim: null, done: 0, left: 0 }; }
  }
  return out;
}
function queryVector(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["model", "dim", "v", "scale"].includes(key))
      || typeof value.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,159}$/.test(value.model)
      || !Number.isInteger(value.dim) || value.dim < 1 || value.dim > 4096) return null;
  try { return VEC().decodeVector(value, value.dim) ? { model: value.model, dim: value.dim, v: value.v, scale: value.scale } : null; }
  catch (_) { return null; }
}
async function opEmbed(b) {
  // These operations use the existing bot-token gate, not a person's permissions or rate bucket.
  const allowed = new Set(b.op === "embed_todo" ? ["password", "op", "model", "dim", "limit", "after"] : ["password", "op", "model", "dim", "vecs"]);
  if (Object.keys(b).some((key) => !allowed.has(key))) throw new Fail("bad", "Embedding jobs cannot carry a speaker or room.", 400);
  if (![true, "true", "1", 1].includes(conf().get().clerk_embed)) throw new Fail("embed_off", "Embeddings are switched off.", 403);
  try {
    const result = b.op === "embed_todo" ? await VEC().todo({ model: b.model, dim: b.dim, limit: b.limit, after: b.after })
      : await VEC().put({ model: b.model, dim: b.dim, vecs: b.vecs });
    if (!result || !result.ok) throw Object.assign(new Error("embed"), { code: result && result.code, logged: !!(result && result.logged) });
    embedTold.delete(b.op);
    return b.op === "embed_put" ? { ok: true, stored: result.stored, rejected: result.rejected, stale: result.rejected } : result;
  } catch (error) {
    const code = error && error.code;
    if (code === "embed_off") throw new Fail("embed_off", "Embeddings are switched off.", 403);
    if (["embed_model", "bad_embed_model"].includes(code)) throw new Fail("embed_model", "The embedding model needs refreshing.", 409);
    if (["bad_cursor", "bad_vector", "bad_vectors", "bad_batch", "too_large"].includes(code)) throw new Fail("bad", "Invalid embedding batch.", 400);
    // plexvectors 1.99amg (prod 2026-11-08: every backfill call "refused catalog_down" while the catalog was ready and a read only
    // slow): busy - the bot backs off and asks again - or down. plexvectors logs the real reason once a streak (logged); anything it
    // didn't tell is said here once a streak, its code only (never its message). No per-call line either way.
    const out = EMBED_BUSY.has(code) ? "embed_busy" : "catalog_down";
    if (!(error && error.logged)) {
      const line = "[plexchat] " + b.op + " refused (" + out + "): " + (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : "error");
      if (embedTold.get(b.op) !== line) { embedTold.set(b.op, line); console.log(line); }
    }
    throw Object.assign(out === "embed_busy" ? new Fail("embed_busy", "The library catalog is busy - the backfill tries again shortly.", 503)
      : new Fail("catalog_down", "The library catalog isn't available right now.", 503), { quiet: true });
  }
}
const EMBED_BUSY = new Set(["embed_busy", "too_broad", "busy", "slow", "SQLITE_BUSY", "SQLITE_LOCKED"]);
const embedTold = new Map();   // embed op -> the refusal line last said (once a streak)
const offers = new Map(), OFFER_MS = 10 * 60000;
function requestsOn() { return !!(conf().on && typeof conf().on.requests === "function" && conf().on.requests()); }
function requestRollout(user) {
  const mode = conf().get().clerk_requests;
  return mode === "everyone" || mode === "staff" && require("./siteperms").atLeast(user, "staff");
}
async function requestRoom(user, b, R) {
  if (!clean(b.room, 100) || b.via != null && !["room", "web"].includes(b.via)) return null;
  const origin = b.target === "cam" ? await padOf(b.room) : R;
  if (origin !== R) await seeOrFail(user, origin);
  return !R.adult && !origin.adult ? origin : null;
}
const offerKey = (user, R, origin, target, item) => JSON.stringify([user.userId, R.id, origin.id, target, item.kind, Number(item.tmdb), item.season == null ? null : Number(item.season)]);
function costOf(cost) {
  if (!cost || !["scout", "credit", "pat", "free"].includes(cost.with)) return null;
  const price = Number(cost.price);
  if (!Number.isSafeInteger(price) || price < 0 || cost.with !== "pat" && price !== 0) return null;
  return { with: cost.with, price };
}
async function requestPreview(user, b, R, origin, item) {
  if (!origin || !requestsOn()) return { may: false, reason: "off" };
  if (!requestRollout(user)) return { may: false, reason: "clerk_off" };
  let rights;
  try { rights = await MR().canRequest(user, item.kind); } catch (e) { return { may: false, reason: "off" }; }
  const reason = ["signin", "unlinked", "level", "limit", "off"].includes(rights && rights.reason) ? rights.reason : "off";
  const cost = costOf(rights && rights.cost);
  if (!rights || !rights.ok || !cost) return { may: false, reason, ...(reason === "level" && Number.isInteger(rights.level) ? { level: rights.level } : {}) };
  const target = b.target === "cam" ? "cam" : "stage";
  for (const [key, offer] of offers) if (now() - offer.at >= OFFER_MS) offers.delete(key);
  while (offers.size >= 5000) offers.delete(offers.keys().next().value);
  offers.set(offerKey(user, R, origin, target, item), { at: now(), item: { ...item }, cost });
  return { may: true, cost };
}
async function opFind(user, b) {
  const { target, R, A } = await clerkAccess(user, b);
  let seenKeys = [];
  // This is the only personal-history read. No supplied user id or another account's history is accepted.
  if (b.ask && b.ask.unseen === true) seenKeys = (await getQuery("SELECT DISTINCT rating_key FROM media_plays WHERE user_id = ? AND rating_key IS NOT NULL", [user.userId])).map((r) => String(r.rating_key));
  let maxSec = Infinity;
  if (target === "stage") {
    const limits = await require("./mainstage").limitsFor(R.id);
    maxSec = Math.max(60, (limits.library_max - ML()._q.SLACK_MIN) * 60);
  }
  let out;
  const origin = requestsOn() ? await requestRoom(user, b, R) : null;
  try { out = await CF().find({ ask: b.ask, raw: clean(b.raw, 100), exclude: b.exclude, limit: b.limit, target, browse: b.op === "browse", probe: b.probe === true,
    qvec: [true, "true", "1", 1].includes(conf().get().clerk_embed) ? queryVector(b.qvec) : null },
    { seenKeys, maxSec, user, allowSeerr: !!origin && requestsOn() }); }
  catch (e) {
    if (e && e.refuse) throw e;
    throw new Fail("catalog_down", "The library shelves are slow right now.", 503);
  }
  if (out.code === "unavailable") throw new Fail("unavailable", "That one isn't available here.", 404);
  if (out.seerr) out.request = await requestPreview(user, b, R, origin, out.seerr);
  const S = conf().get(), per = A.free ? 0 : Math.max(0, Math.floor(Number(S.library_price) || 0));
  const state = await ML().padState(user, R.id).catch(() => null);
  for (const row of [...out.rows, ...(out.alternatives || [])]) {
    const sec = Array.isArray(row.keys) ? row.total_sec : row.duration;
    if (Array.isArray(row.keys)) row.estimate = per ? MQ().estimate(per, sec) : 0;
    else {
      row.price = per ? ML().priceFor(sec, 0, S).price : 0;
      if (row.kind === "episode") row.estimate = per ? MQ().estimate(per, sec) : 0;
    }
    if (target === "stage" && state && state.library && state.library.queue && state.library.can_add) row.next_cost = await MQ().addCostFor(R.id, sec || 0).catch(() => 0);
    if (target === "stage") { const qc = await queueCost(user, R, state, A, sec); if (qc != null) row.queue_cost = qc; }   // 1.99?? plexqueue
  }
  return { ok: true, ...out, clerk: S.clerk_enabled, free: !!A.free, how: A.how || null, per_hour: per, state, target, pad: { id: R.id, title: R.title || R.id } };
}
async function opRequest(user, b) {
  const { target, R } = await clerkAccess(user, b);
  const origin = await requestRoom(user, b, R);
  if (!origin || !requestsOn() || !requestRollout(user)) throw new Fail("request_off", "Requests aren't available here.", 403);
  const kind = ["movie", "tv"].includes(b.kind) ? b.kind : null;
  const tmdb = /^\d{1,9}$/.test(String(b.tmdb)) ? Number(b.tmdb) : null;
  const season = b.season == null ? null : intOr(b.season, 1, 200);
  if (!kind || !tmdb || b.season != null && (kind !== "tv" || season == null || Number(b.season) !== season)) throw new Fail("request_stale", "Ask for a fresh request offer.", 409);
  const key = offerKey(user, R, origin, target, { kind, tmdb, season }), offer = offers.get(key);
  if (!offer || now() - offer.at >= OFFER_MS) { offers.delete(key); throw new Fail("request_stale", "Ask for a fresh request offer.", 409); }
  offers.delete(key); // Claim before the first await: a repeated or simultaneous yes cannot send another request.
  let rights;
  try { rights = await MR().canRequest(user, kind); }
  catch (e) { throw new Fail("upstream", "The request service isn't available right now.", 502); }
  if (!rights || !rights.ok) {
    const reason = rights && rights.reason, code = reason === "off" ? "request_off" : ["signin", "level", "limit"].includes(reason) ? reason : "request_off";
    throw new Fail(code, "The request could not be sent.", code === "limit" ? 429 : 403);
  }
  if (JSON.stringify(costOf(rights.cost)) !== JSON.stringify(offer.cost)) throw new Fail("request_stale", "The request cost changed. Ask for a fresh offer.", 409);
  try {
    const result = await MR().request(user, { type: kind, tmdb, ...(season != null ? { seasons: [season] } : {}) });
    const status = ["submitting", "pending", "approved", "partial", "available", "declined", "failed"].includes(result.status) ? result.status : "pending";
    const cost = costOf({ with: result.paid_with, price: result.price }) || offer.cost;
    return { ok: true, status, label: status, paid_with: cost.with, price: cost.price };
  } catch (e) {
    let code = "upstream";
    if (e && e.refuse) {
      if (e.status === 401) code = "signin";
      else if (e.status === 403) code = requestsOn() ? "level" : "request_off";
      else if (e.status === 429) code = "limit";
      else if (e.status === 409) code = /already on Plex|already available/i.test(String(e.message || "")) ? "available" : "requested";
      else if (e.status === 402) code = "pat";
    }
    throw new Fail(code, "The request could not be sent.", e && e.status || 502);
  }
}
async function opSearch(user, b) {
  const target = b.target === "cam" ? "cam" : "stage";
  const R = target === "cam" ? await padOf(rooms().HOUSE_ROOM) : await padOf(b.room);
  await seeOrFail(user, R);
  if (target === "cam") await camOrFail(user);                          // no picker for a cam pick that can't happen
  await ML().init();
  const A = await ML()._q.mustAccess(user);
  const q = clean(b.q, 100);
  if (q.length < 2) throw new Fail("bad", "Say a title.", 400);
  const want = { year: intOr(b.year, 1880, 2100), season: intOr(b.season, 0, 200), episode: intOr(b.episode, 0, 2000),
                 hint: b.hint === "movie" || b.hint === "show" ? b.hint : null };
  const S = conf().get();
  const per = A.free ? 0 : Math.max(0, Math.floor(Number(S.library_price) || 0));
  const found = (await ML().search(user, q)).filter((x) => x && ["movie", "show", "episode"].includes(x.type));
  const ranked = found.map((it, i) => ({ it, s: score(it, q, want), i })).sort((a, b2) => (b2.s - a.s) || (a.i - b2.i)).slice(0, 8);
  const rows = [];
  let shows = 0;
  for (const { it, s } of ranked) {
    if (rows.length >= 5) break;
    const exact = s >= 100;
    if (it.type === "movie") {
      rows.push(slim({ key: String(it.key), type: "movie", title: it.title, year: it.year, duration: it.duration, scope: "title", exact,
                       price: per ? ML().priceFor(it.duration, 0, S).price : 0, label: labelOf(it) }));
    } else if (it.type === "episode") {
      rows.push(slim({ key: String(it.key), type: "episode", title: it.title, show: it.show, season: it.season, episode: it.episode, year: it.year,
                       duration: it.duration, scope: "episode", exact: exact && want.episode == null, price: per ? ML().priceFor(it.duration, 0, S).price : 0,
                       estimate: per ? MQ().estimate(per, it.duration) : 0, label: labelOf(it) }));
    } else if (it.type === "show") {
      if (shows >= 3) continue;                                          // each show costs a lookup: the best few only
      shows++;
      const show = await ML()._q.fetchItem(it.key).catch(() => null);
      const eps = MQ().sortEps((show && show.episodes) || []);
      if (!eps.length) continue;
      const real = eps.filter((e) => (Number(e.season) || 0) !== 0);
      if (want.season != null && want.episode == null) {
        const se = eps.filter((e) => (Number(e.season) || 0) === want.season);
        if (!se.length) continue;
        const capped = MQ().capQueue(se.map(MQ().slim), 0, { maxItems: S.library_queue_max_items || 60, maxSec: (S.library_queue_max_hours || 12) * 3600 });
        rows.push(slim({ key: String(se[0].key), type: "season", show: it.title, title: it.title, year: it.year, season: want.season, scope: "season",
                         items: capped.items.length, total_sec: capped.total_sec, exact, estimate: per ? MQ().estimate(per, capped.total_sec) : 0,
                         first_title: se[0].title || null, label: `${it.title} S${want.season}` }));
      } else {
        const sn = want.season != null ? want.season : 1;
        const e = want.episode != null ? eps.find((x) => (Number(x.season) || 0) === sn && Number(x.episode) === want.episode)
          : (real[0] || eps[0]);
        if (!e) continue;
        rows.push(slim({ key: String(e.key), type: "episode", title: e.title, show: e.show || it.title, season: e.season, episode: e.episode, year: it.year,
                         duration: e.duration, scope: "episode", exact, price: per ? ML().priceFor(e.duration, 0, S).price : 0,
                         estimate: per ? MQ().estimate(per, e.duration) : 0, label: labelOf({ ...e, show: e.show || it.title }) }));
      }
    }
  }
  const state = await ML().padState(user, R.id).catch(() => null);
  // 1.99ajk plexchat review: the pad's running 📼 queue that this speaker may add to (its starter): what each row would ADD to that
  // queue's bill (its own per-hour rate, on top of what's paid) - "queue it next" confirms that figure, not a standalone price
  if (target === "stage" && state && state.library && state.library.queue && state.library.can_add) {
    for (const row of rows) {
      const secs = row.type === "season" ? row.total_sec : row.duration;
      row.next_cost = (await MQ().addCostFor(R.id, secs || 0).catch(() => null)) || 0;
    }
  }
  // 1.99?? plexqueue: what "queue it" costs THIS speaker (padState library.queue_as: the end of their running queue / a queue of their own after
  // what's on) - the figure play mode queue wants confirmed (a 409 re-asks with the right one)
  if (target === "stage") {
    for (const row of rows) {
      const qc = await queueCost(user, R, state, A, row.type === "season" ? row.total_sec : row.duration);
      if (qc != null) row.queue_cost = qc;
    }
  }
  return { ok: true, rows, free: !!A.free, how: A.how || null, per_hour: per, state, target, pad: { id: R.id, title: R.title || R.id } };
}
/** 1.99?? plexqueue: what queueing `secs` of titles costs `user` on pad R (state = padState: its library.queue_as says how) - null: no queueing */
async function queueCost(user, R, state, A, secs) {
  const how = state && state.library ? state.library.queue_as : null;
  if (how === "append") return (await MQ().addCostFor(R.id, secs || 0).catch(() => null)) || 0;
  if (how === "after") return await MQ().afterCostFor(user, R.id, secs || 0, A).catch(() => 0);
  return null;
}

async function opPlay(user, b, ctx) {
  const target = b.target === "cam" ? "cam" : "stage";
  const listed = Array.isArray(b.keys) || b.scope === "list" || b.scope === "series";
  const keys = Array.isArray(b.keys) ? b.keys.map(String) : [];
  const key = String(b.key == null ? keys[0] || "" : b.key);
  if (!/^\d{1,12}$/.test(key)) throw new Fail("bad", "Bad item.", 400);
  const scope = SCOPES.has(b.scope) ? b.scope : "title";
  const price = b.price == null || b.price === "" ? undefined : Math.floor(Number(b.price));
  if (target === "cam") {
    const R = await padOf(rooms().HOUSE_ROOM);
    await seeOrFail(user, R);
    if (listed || b.clerk === true) {
      await camOrFail(user);
      await ML().init();
      await ML()._q.mustAccess(user);
      clerkOrFail(user);
      if (listed) throw new Fail("bad", "Pepe's stream takes one title at a time.", 400);
      await CF().validateKeys([key]);
    }
    const by = ctx.via === "web" ? "web:" + user.username : "pepe:" + (clean(ctx.login, 40) || user.username);
    const r = await OA().libraryFor(user, key, by, { price, mode: ["now", "next", "replace"].includes(b.mode) ? b.mode : "now" });
    const T = (OA().view() || {}).target || null;
    return { ok: true, target: "cam", queued: !!(r && r.queued), irl: !!(r && r.irl), title: r && r.title ? r.title : null, id: r && r.id ? r.id : null,
             ahead: r && r.ahead != null ? r.ahead : null, on_air: T ? T.label : null };
  }
  const R = await padOf(b.room);
  await seeOrFail(user, R);
  if (listed || b.clerk === true) {
    await ML().init();
    await ML()._q.mustAccess(user);
    clerkOrFail(user);
    await CF().validateKeys(listed ? keys : [key]);
    if (listed && keys.length > (conf().get().library_queue_max_items || 60)) throw new Fail("queue_full", "That list is longer than the queue limit.", 409);
  }
  if (b.mode === "queue") {
    // 1.99?? plexqueue (owner 2026-11-08): Pepe's "queue it" = /stage's "+ Add to the queue" on this pad (mediaqueue.queueFor - its rules, its
    // billing: the speaker's own, as it plays; estimate = the queue_cost they said yes to, 400 / 409 otherwise)
    const est = b.estimate == null || b.estimate === "" ? undefined : Math.floor(Number(b.estimate));
    // (review F8: behind_slot = the slot the confirm named - padState library.behind_slot; behind_changed if something else is on by the yes)
    const behind_slot = typeof b.behind_slot === "string" && /^[A-Za-z0-9-]{8,64}$/.test(b.behind_slot) ? b.behind_slot : null;
    const r = await MQ().queueFor(user, R.id, { ...(listed ? { keys } : { key, scope: scope === "title" || scope === "episode" ? null : scope }), estimate: est,
                                                ...(behind_slot ? { behind_slot } : {}) });
    const cost = r.cost != null ? r.cost : r.estimate || 0;
    return { ok: true, target: "stage", queued: true, how: r.how, title: r.title || r.next || null, added: r.added || 0, items: r.items || 0, cost, free: !(cost > 0),
             per_hour: r.per_hour || 0, place: r.place || null, line: r.line || null, eta_sec: r.eta_sec != null ? r.eta_sec : null, behind: r.behind || null,
             behind_queue: !!r.behind_queue, behind_left: r.behind_left || 0, queue_id: r.queue_id || null, pad: { id: R.id, title: R.title || R.id } };
  }
  if (b.mode === "next") {
    // on a paid queue: what it adds to the starter's bill, as the starter said yes to it (400 / 409 estimate otherwise)
    const est = b.estimate == null || b.estimate === "" ? undefined : Math.floor(Number(b.estimate));
    const r = await MQ().addNext(user, R.id, listed ? keys : [key], { estimate: est, scope: listed || scope === "title" || scope === "episode" ? null : scope });
    return { ok: true, target: "stage", queued: true, title: r.next, added: r.added, cost: r.cost || 0, pad: { id: R.id, title: R.title || R.id } };
  }
  // 1.99?? plexqueue review F2: something from Plex started between Pepe's question and a plain yes (busy_library / busy_queue): the refusal says
  // what THIS speaker may do about it now (padState) and what queueing the title costs them (b.secs - its length as the row said; only a figure
  // to confirm: the queue yes is checked against the site's own, 400 / 409) - Pepe offers queue / replace right there. An older Pepe reads
  // can_replace / playing* as before
  try { return await plainPlay(user, b, R, { listed, keys, key, scope, price }); }
  catch (e) {
    if (b.mode !== "replace" && e && e.refuse && e.extra && ["busy_library", "busy_queue"].includes(e.extra.code)) await busyState(user, R, b, e);
    throw e;
  }
}
/** (review F2) a busy refusal of a plain play + the speaker's padState and queue_cost for b.secs. Never throws. */
async function busyState(user, R, b, e) {
  try {
    const state = await ML().padState(user, R.id);
    if (!state) return;
    e.extra.state = state;
    const secs = intOr(b.secs, 1, 7 * 24 * 3600);
    if (secs != null && state.library && state.library.queue_as) {
      const A = await ML()._q.mustAccess(user).catch(() => null);
      const qc = A ? await queueCost(user, R, state, A, secs) : null;
      if (qc != null) e.extra.queue_cost = qc;
    }
  } catch (err) { /* the refusal goes out as it was */ }
}
async function plainPlay(user, b, R, { listed, keys, key, scope, price }) {
  const S = conf().get();
  // plexreplace: Pepe's "play X instead?" + yes. Review fix: replace_slot = the slot his question named (padState library.slot_id / a busy
  // refusal's playing_slot) - the site refuses replace_changed if something else is on by the yes; an older Pepe without it: whatever is on
  const slotArg = typeof b.replace_slot === "string" && /^[A-Za-z0-9-]{8,64}$/.test(b.replace_slot) ? b.replace_slot : null;
  const rep = b.mode === "replace" ? { replace: slotArg || true } : {};
  const replaced = (r) => (r && r.replaced ? { replaced: { title: r.replaced.title || null, queue: !!r.replaced.queue } } : {});
  if (listed) {
    const estimate = b.estimate == null || b.estimate === "" ? undefined : Math.floor(Number(b.estimate));
    const r = await MQ().startFor(user, { room: R.id, keys, scope: scope === "series" ? "series" : "list", ...(estimate !== undefined ? { estimate } : {}), ...rep });
    return { ok: true, target: "stage", title: r.title, price: r.price || 0, queue: true, items: r.items, total_sec: r.total_sec, estimate: r.estimate || 0,
      per_hour: r.per_hour || 0, pad: { id: R.id, title: R.title || R.id }, ...replaced(r) };
  }
  if (scope === "title" || (scope === "episode" && S.library_queue === false)) {
    const r = await ML().playFor(user, { room: R.id, key, ...(price !== undefined ? { price } : {}), ...rep });
    return { ok: true, target: "stage", title: r.title, price: r.price || 0, queue: false, pad: { id: R.id, title: R.title || R.id }, ...replaced(r) };
  }
  const estimate = b.estimate == null || b.estimate === "" ? undefined : Math.floor(Number(b.estimate));
  const r = await MQ().startFor(user, { room: R.id, key, scope, ...(estimate !== undefined ? { estimate } : {}), ...rep });
  return { ok: true, target: "stage", title: r.title, price: r.price || 0, queue: true, items: r.items, total_sec: r.total_sec, estimate: r.estimate || 0,
           per_hour: r.per_hour || 0, pad: { id: R.id, title: R.title || R.id }, ...replaced(r) };
}

async function opControl(user, b) {
  const R = await padOf(b.room);
  await seeOrFail(user, R);
  const action = String(b.action || "");
  const clock_ = ML()._q.clock;
  const pad = { id: R.id, title: R.title || R.id };
  const s = await ML()._q.session(R.id);
  if (action === "pause") { const r = await ML().pause(user, R.id); return { ok: true, action, at: clock_(r.position || 0), pad }; }
  if (action === "resume") { await ML().resume(user, R.id); return { ok: true, action, pad }; }
  if (action === "stop") { await ML().stop(user, R.id, "stopped"); return { ok: true, action, pad }; }
  if (action === "seek" || action === "seek_rel") {
    if (!s) throw new Fail("nothing_on", "Nothing from the library is playing on this pad.", 404);
    const v = Math.floor(Number(b.value));
    if (!Number.isFinite(v)) throw new Fail("bad", "Bad position.", 400);
    const here = Math.max(0, Number(s.position) || 0) + (s.state === "playing" ? Math.max(0, (now() - Number(s.updated || now())) / 1000) : 0);
    const to = Math.max(0, Math.min(action === "seek" ? v : Math.round(here + v), Math.max(0, (Number(s.duration) || 0) - 30)));
    const r = await ML().seek(user, R.id, to);
    return { ok: true, action, from: clock_(here), to: clock_(r.position != null ? r.position : to), pad };
  }
  if (action === "next" || action === "prev") {
    const q = await MQ().activeFor(R.id);
    if (!q) {
      if (s) throw new Fail(action === "next" ? "last_title" : "first_title", "That's the only title playing.", 409);
      throw new Fail("nothing_on", "Nothing from the library is playing on this pad.", 404);
    }
    const r = action === "next" ? await MQ().next(user, R.id) : await MQ().prev(user, R.id);
    return { ok: true, action, title: r.title || null, ended: !!r.ended, pad };
  }
  throw new Fail("bad", "Bad control.", 400);
}

async function opNp(user, b) {
  const target = b.target === "cam" ? "cam" : "stage";
  const out = { ok: true, target };
  if (target === "cam") {
    const T = (OA().view() || {}).target || null;
    out.on_air = T ? T.label : null;
    // 1.99akr onairtitle: + the video's title when it's an embed (the label alone said only "🔗 YouTube video")
    const ti = T && OA().titleOf ? OA().titleOf(T) : null;
    out.on_air_title = ti && ti.title ? ti.title : null;     // a held title (onairtitle.vet) is never sent
    return out;
  }
  const R = await padOf(b.room);
  await seeOrFail(user, R);
  const v = await ML().player(user, R.id);
  Object.assign(out, { on: !!v.on, title: v.title || null, state: v.state || null, position: Math.round(Number(v.position) || 0),
                       duration: v.duration || null, by: v.by || null, can_control: !!v.can_control, pad: { id: R.id, title: R.title || R.id } });
  if (v.on && v.state === "playing" && v.at) out.position = Math.round(out.position + Math.max(0, (now() - v.at) / 1000));
  if (v.queue) out.next = v.queue.next && v.queue.next[0] ? ML().fmtTitle(v.queue.next[0]) : null;
  return out;
}

async function opContinue(user, b) {
  const R = await padOf(b.room);
  await seeOrFail(user, R);
  await ML().init();
  const A = await ML()._q.mustAccess(user);
  const show = norm(clean(b.show, 100));
  const rows = await getQuery("SELECT rating_key, title FROM media_plays WHERE user_id = ? AND kind = 'episode' AND ts > ? AND rating_key IS NOT NULL ORDER BY id DESC LIMIT 20",
                              [user.userId, now() - CONTINUE_MS]);
  const hit = rows.find((r) => !show || norm(String(r.title || "").split(" — ")[0]) === show || norm(String(r.title || "")).startsWith(show + " "));
  if (!hit) return { ok: true, row: null };
  const nxt = await MQ().nextEpisodeOf({ type: "episode", key: String(hit.rating_key) });
  if (!nxt) return { ok: true, row: null, last: String(hit.title || "") };
  const S = conf().get();
  const per = A.free ? 0 : Math.max(0, Math.floor(Number(S.library_price) || 0));
  const row = slim({ key: nxt.key, type: "episode", title: nxt.title, show: nxt.show, season: nxt.season, episode: nxt.episode, duration: nxt.duration,
                     scope: "episode", exact: true, price: per ? ML().priceFor(nxt.duration, 0, S).price : 0,
                     estimate: per ? MQ().estimate(per, nxt.duration) : 0, label: labelOf(nxt) });
  const state = await ML().padState(user, R.id).catch(() => null);
  // 1.99?? plexqueue: with something on, Pepe offers "queue it" for the next episode too - what that costs this speaker (+ how / the pad, for its words)
  const qc = await queueCost(user, R, state, A, nxt.duration);
  if (qc != null) row.queue_cost = qc;
  return { ok: true, row, free: !!A.free, how: A.how || null, state, pad: { id: R.id, title: R.title || R.id } };
}

async function opRpm(user, b) {
  const R = await padOf(b.room);
  await seeOrFail(user, R);
  const text = clean(b.text, 400);
  if (!text) throw new Fail("bad", "Nothing to say.", 400);
  require("./bridge-relay").roomPmLocal(user.userId, R.id, text, "plex");
  return { ok: true };
}

// ── the audit trail (1.99ajk plexchat review) ──
/** A play / a control through Pepe -> one media_controls row ("pepe", e.g. "room chat as alice: play 100 -> The Matrix (1999)"): the
 *  pad's "Who did what" list and the site's records say it came from chat, and which login / account asked. Never blocks. */
async function audit(user, b, ctx, op, r) {
  try {
    const room = b.target === "cam" ? rooms().HOUSE_ROOM : (r.pad && r.pad.id) || b.room;
    const how = (ctx.via === "web" ? "web chat" : "room chat") + (ctx.login ? " as " + clean(ctx.login, 40) : "");
    // 1.99?? plexqueue: mode queue - "queue" (the end of their own running queue) / "line up" (a queue of their own after what's on: its own action,
    // pepe_after, under the 📼 log's privacy rule for line-ups - only the pad's owner / admins see who lined up after someone's title)
    const qw = b.mode === "queue" && b.target !== "cam" ? (r.how === "after" ? "line up " : "queue ") : "";
    const what = op === "play" ? `${b.target === "cam" ? "cam " : ""}${qw}${b.mode === "next" ? "next " : b.mode === "replace" && b.target !== "cam" ? "instead " : ""}play ${clean(b.key, 12)}${r.title ? " -> " + clean(r.title, 80) : ""}`
      : `${clean(b.action, 12)}${b.value != null ? " " + clean(b.value, 12) : ""}`;
    await ML().logControl(user, String(room || ""), op === "play" && r.how === "after" ? "pepe_after" : "pepe", `${how}: ${what}`.slice(0, 160));
  } catch (e) { /* the log never blocks a play */ }
}

// ── the route ──
const hits = new Map();               // userId -> [ms...] (30 ops a minute per account)
function rateOk(userId, t = now()) {
  const a = (hits.get(userId) || []).filter((x) => t - x < RATE_MS);
  if (a.length >= RATE_MAX) { hits.set(userId, a); return false; }
  a.push(t);
  hits.set(userId, a);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] > RATE_MS) hits.delete(k);
  return true;
}

/** The speaker as Pepe named it (before any lookup): "u:<id>" | "l:<login>" | "?" - the first rate limit's key. */
function asKey(as) {
  const a = as && typeof as === "object" ? as : {};
  if (a.user_id != null && String(a.user_id).trim()) return "u:" + String(a.user_id).trim().slice(0, 80);
  if (a.login != null && String(a.login).trim()) return "l:" + String(a.login).trim().toLowerCase().slice(0, 40);
  return "?";
}

/** One bot request (already authenticated) -> the answer body (never throws). */
async function handle(b = {}) {
  const op = String(b.op || "");
  try {
    if (!OPS.has(op)) throw new Fail("bad", "Unknown op.", 400);
    if (op === "embed_todo" || op === "embed_put") return await opEmbed(b);
    const via = b.via === "web" ? "web" : "room";
    if (!rateOk(asKey(b.as))) throw new Fail("rate", "Too many Plex requests - give it a minute.", 429);
    const user = await resolve(b.as);
    if (!rateOk(user.userId)) throw new Fail("rate", "Too many Plex requests - give it a minute.", 429);
    const ctx = { via, login: b.as && b.as.login ? String(b.as.login) : null };
    let r;
    if (op === "search") r = await opSearch(user, b);
    else if (op === "find" || op === "browse") r = await opFind(user, b);
    else if (op === "request") r = await opRequest(user, b);
    else if (op === "shelves") r = await opShelves(user, b);
    else if (op === "play") r = await opPlay(user, b, ctx);
    else if (op === "control") r = await opControl(user, b);
    else if (op === "np") r = await opNp(user, b);
    else if (op === "continue") r = await opContinue(user, b);
    else r = await opRpm(user, b);
    if ((op === "play" || op === "control") && r && r.ok) await audit(user, b, ctx, op, r);
    console.log(`[plexchat] ${via} ${user.username}: ${op}${b.action ? " " + clean(b.action, 12) : ""}${b.key ? " " + clean(b.key, 12) : ""} -> ok`);
    return { ...r, user: { username: user.username } };
  } catch (e) {
    const body = failBody(e);
    if (body.code === "error") console.error("[plexchat]", op, e && e.stack ? e.stack : e);
    else if (!(e && e.quiet)) console.log(`[plexchat] ${op}: refused ${body.code}`);   // quiet: its reason was logged once already
    return body;
  }
}

function register(app, { isBotToken } = {}) {
  const parse = express.json({ limit: "16kb" });
  app.post("/api/medialib/bot", parse, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    if (typeof isBotToken !== "function" || !isBotToken(b.password)) return res.status(403).json({ ok: false, code: "auth", error: "unauthorized" });
    res.json(await handle(b));
  });
}

module.exports = { register, handle, resolve, codeOf, failBody, score, norm, asKey, CODES, RATE_MAX,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); }, _hits: hits };
