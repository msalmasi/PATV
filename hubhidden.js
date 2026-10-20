// hubhidden.js — Pepe's hidden set, kept STICKY for the website (quotes) and the chat hub (R-14 / the privacy seam, 1.99acm; the
// chat design §1.7, §3.7, §9.2, seam plan D-5 / D-6). 1.99add: sticky - the chat-history design's rule (spec §3.1, the privacy
// critique's B1): an empty, short or truncated list from Pepe un-hides nobody. 1.99add refix 4 (the owner's rule of 2026-10-19:
// incognito hides WHO, not WHAT): the set keeps WHY each person is hidden.
//
// Hashes only - never a login: sha256("pepe-hidden:" + lower(trim(login)))[:20] (quotes.hiddenHash). Every hash carries one or
// more KINDS, each its own row:
//   bridge     !bridge hide                                   their lines are LEFT OUT (quotes, the hub)
//   incognito  !incognito / the website's switch              their lines are shown as "someone" - no name, the words stay
//   unknown    an older Pepe's mixed hidden_h list (bridge    LEFT OUT (fail closed): the site can't tell which it was. On prod
//              hide and incognito in one list)               Pepe 1.99adc incognito people are left out too until his sync says
//                                                            the kind (bridge_hidden_h / incog_hidden_h below)
// A hash is hidden while it has any kind; left out while it has bridge or unknown. quotes.isHidden (any kind) also drives pad tips
// (refused as private), boost and go-live lines (no name) and @mention alerts (none); quotes.isLeftOut picks the quote lines
// that are dropped instead of anonymised (quotes.js). The hub's copy carries `scope: "incognito"` on a hash hidden ONLY by
// incognito (huboutbox.js) - absent = left out, as every hub row was before.
//
// ADDED (sticky; the src says how sure the site is - only an incognito row can be less than "pepe"):
//   * Pepe's bridge sync: hidden_h (every Pepe: everyone he hides now, mixed) -> unknown for each hash his kinded lists don't
//     carry; bridge_hidden_h -> bridge, incog_hidden_h -> incognito (a Pepe that knows the kinds; each list is left out - null -
//     when that state failed to load, so a list he sends is one he vouches for). A privacy.hidden {h, scope} event -> that
//     kind (no / another scope -> unknown);
//   * Pepe's incognito ON report (hiddenReported, src "report") - ALWAYS, also when it looks older than his last OFF (a clock
//     that went back must not leave anyone named); his full incognito list (fullReported, every 10 min - adds only);
//   * a website Incognito ON request (hideNow, src "web": at once, before Pepe confirms; provisional).
// REMOVED - each removal takes away ONE kind, never the others:
//   * privacy.shown {h, scope: bridge | incognito} (Pepe CL1) -> that kind; also the unknown row when no list of the same sync
//     carries the hash (nothing else hides them in Pepe now). Not when the same sync's list of that kind still carries it (the
//     list is who is hidden now), not a resend (event id seen), not one of a late post of an older run, not one older (his
//     clock) than a hide of that kind that arrived in the last STALE_MS (a late post);
//   * Pepe's incognito OFF report (offReported; linked or not, changed or not - Pepe has them off) -> the incognito row, unless
//     older than an ON of theirs that arrived in the last STALE_MS (a late post: they stay hidden); webSettled (a website ON
//     he never applied) -> a "web" incognito row;
//   * an OLDER Pepe (no tx_hidden_h: he sends no privacy.shown) -> the unknown row of a hash his list had and his next TWO whole,
//     in-order lists of the same bridge session lack (one short list un-hides nobody: a transient read failure in his
//     _br_hidden_hashes) - at the FIRST such list when his own incognito OFF report (a real change) dated after the list that
//     still had them and no later than the list that lacked them explains it. More than HOLD_N unexplained in one list (or
//     more than HOLD_PCT of the set, when 2+) are HELD. What his last list had (or lacked once) and his first whole list after
//     a restart (a new session) lacks is HELD ("restart") unless explained the same way. Prod Pepe 1.99adc passes on a
//     !bridge show or an admin-panel un-hide this way - deploy after the acl-nick bot fix (a room-line impersonator could
//     otherwise type !bridge show or !incognito off for someone else);
//   * a Pepe that knows the kinds: an unknown row whose hash his vouched lists carry is RESOLVED to those kinds (not an un-hide);
//     one neither list carries is HELD ("legacy") once per run - he hid them before he knew the kinds and dropped them since;
//   * an owner on /admin/keys#seam: un-hide one chat login or hash, one kind or all (audited, hash only), or approve a HELD
//     batch (its unknown rows; audited without a hash).
// ORDER. Lists of one run are taken in the order they ARRIVE (Pepe posts one at a time); their `sent` and his reports' `ts` are
// compared only with each other - never with the site's clock. A list whose `sent` is older than the one taken before it (his
// clock went back, or a late post) is compared with nothing (what it lacks counts for nothing) but becomes the list the next one
// is compared with, together with what the list before it had (nothing it lacked is skipped), and no window from it explains a
// drop (two lists decide). A list of an OLDER run (a session seen before, arriving late) only adds. A list without a `sent` only adds.
// A list "whole" = not possibly cut: an older Pepe sorts his list and cuts it at TRUNC, so a list that long proves nothing by what
// it lacks (a CL1 Pepe sends it uncut: up to MAX).
// HELD (hub_hidden_held, spec §3.1): unknown rows that vanished in a way that may be a lost state wait for an owner - they stay
// hidden meanwhile. kind "mass" (too many off one list), "restart" (across his restart), "legacy" (above). A held hash Pepe
// lists again leaves its batch; a "mass" batch whose others were all EXPLAINED (Pepe's own word - privacy.shown, an OFF report -
// about a change between the list before the drop and the first list without it, `prev_ts` < at <= `sent_ts`, his clock)
// releases its last one. Anything else (an owner's un-hide, a merged batch) makes it "manual": the owner decides the rest.
// scope "tx" (!transcripts off: 🎙 lines only) is another set - it never adds or removes anything here.
//
// STORED - whatever the switches say:
//   hub_hidden_set(h, kind, since, src; PRIMARY KEY (h, kind))      one row per kind (src: pepe | report | web - incognito only)
//   hub_hidden_meta(key, value, updated)    'last' (the list compared with, Pepe's recent runs, the hashes absent once), 'offs'
//                                           (his newest real incognito OFF per hash - what explains a drop)
//   hub_hidden_held(id, kind, hs (JSON), at, state, relisted, decided_at, manual, prev_ts, sent_ts)   (who decided: admin_audit)
// and ONLY while the hubseam.privacy switch is on, the chat hub's copy:
//   hub_hidden_h(h TEXT PRIMARY KEY, since INTEGER NOT NULL, scope TEXT)    scope "incognito" = hidden only by incognito
// (turning the switch off empties it: huboutbox.setSettings; the first write after it turns on writes the whole set). Triggers
// (huboutbox.js, switch hubseam.privacy) turn each insert / delete / scope change into a privacy/changed row "hh:<h>", so the hub
// only ever hears value false for a hash whose every kind was explicitly removed. Both tables are written in ONE transaction; a
// write inserts what memory holds and deletes ONLY rows explicitly removed.
// boot() (bridge.register; retried on a timer and on the next call when the read fails) loads it all at start-up. Until it has
// worked, the readers treat EVERYONE as hidden and left out (loading(): quotes refuse, tips are refused, no names, no mention
// alerts) - a failed read never names anyone - and a list only ADDS (nothing compared, the stored meta never overwritten).
// Writes are serialised (every call arriving before the next write starts shares it) and the bridge sync never waits for them.
"use strict";
const crypto = require("crypto");
// (dbUtils is loaded on first use: hash() / loginHash() never open the database - tools/hubseam-vectors.js uses them)
const db = () => require("./dbUtils");

const MAX = 5000;                                     // valid hashes taken from one list
const SET_MAX = 100000;                               // the sticky set's ceiling (hashes in memory): a guard against a runaway list
const EVENTS_MAX = 2000;                              // bridge-sync events looked at for privacy.* (bridge.js ingests the first 500)
const TRUNC = 3000;                                   // an older Pepe's cut (pepe_bridge._br_hidden_hashes: sorted, [:3000])
const HOLD_N = 5;                                     // an older Pepe: more than this many vanishing from one list,
const HOLD_PCT = 0.1;                                 //   or more than this share of the set (when 2+), is a lost state: held
const REMOVED_MAX = 20000;
const OFFS_MAX = 5000;                                // Pepe's newest real incognito OFF per hash, kept (explains a drop)
const SEEN_MAX = 20000;                               // privacy.shown event ids taken (a resend is ignored)
const HELD_OPEN_MAX = 200;                            // open held batches (more: merged into the newest one of the kind)
const HELD_KEEP_MS = 90 * 24 * 3600 * 1000;           // decided / void batches are kept this long (pruned at start-up)
// an un-hide dated (his clock) before a hide of the same kind that ARRIVED less than this ago is a late post of an older payload
// (an overlapping retry): ignored. Older than this, his clock went back since - it counts (a late post can't be that late:
// Pepe posts one at a time with a 15 s timeout)
const STALE_MS = 120 * 1000;
const RUNS_MAX = 16;                                  // Pepe's recent bridge sessions remembered (a late post of an older run)
const CLOCK_WARN_MS = 60 * 1000;                      // his clock this far from ours is shown on the seam card (nothing uses it)
const BOOT_RETRY_MS = [5000, 30000, 120000];          // a failed start-up read: tried again after these (then every 120 s)
const HASH_RE = /^[0-9a-f]{20}$/;
const ID_RE = /^[0-9a-f]{12}$/;
const LOGIN_RE = /^[A-Za-z0-9_.$-]{1,40}$/;          // the logins the hub accepts (ASCII; seam plan D-6)
const KINDS = ["bridge", "incognito", "unknown"];
const SCOPE_KIND = { bridge: "bridge", incognito: "incognito" };   // privacy.* data.scope -> kind ("tx": another set)
const HELD_KINDS = ["mass", "restart", "legacy", "order"];   // ("order": a batch from before refix 4 - never formed now)
const RANK = { web: 1, report: 2, pepe: 3 };          // how sure the site is that Pepe hides an incognito row (src)

let clock = () => Date.now();
const now = () => clock();

/** quotes.hiddenHash's form: sha256("pepe-hidden:" + lower(trim(s))), first 20 hex. */
const hash = (s) => crypto.createHash("sha256").update("pepe-hidden:" + String(s == null ? "" : s).trim().toLowerCase(), "utf8").digest("hex").slice(0, 20);
/** The hash of a chat login the hub accepts, else null (the hub would quarantine its row). */
function loginHash(login) {
  if (typeof login !== "string") return null;
  const t = login.trim();
  return LOGIN_RE.test(t) ? hash(t) : null;
}
const cleanHash = (x) => (typeof x === "string" && HASH_RE.test(x) ? x : null);
/** Pepe's ISO `sent` (or a report's ms) -> ms, else null. */
function ms(x) {
  if (typeof x === "number") return Number.isFinite(x) && x > 0 ? Math.floor(x) : null;
  if (typeof x !== "string" || !x || x.length > 40) return null;
  const t = /^\d+$/.test(x) ? Number(x) : Date.parse(x);
  return Number.isFinite(t) && t > 0 ? Math.floor(t) : null;
}
const tooMany = (n, size) => n > HOLD_N || (n >= 2 && n > HOLD_PCT * size);
/** keys (one or a list) -> their hashes (blank ones skipped) */
function hashesOf(keys) {
  const out = [];
  for (const k of Array.isArray(keys) ? keys : [keys]) if (k != null && String(k).trim()) out.push(hash(k));
  return out;
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      const { runQuery, getQuery, tx } = db();
      await runQuery("CREATE TABLE IF NOT EXISTS hub_hidden_h (h TEXT PRIMARY KEY, since INTEGER NOT NULL)");
      // refix 4: the hub's copy says when a hash is hidden ONLY by incognito (shown as "someone", not left out)
      if (!(await getQuery("PRAGMA table_info(hub_hidden_h)")).some((c) => c.name === "scope")) await runQuery("ALTER TABLE hub_hidden_h ADD COLUMN scope TEXT");
      // refix 4: one row per kind. A table from before (h PRIMARY KEY, no kind) is rebuilt: a row only a website ON / Pepe's ON
      // report put there was incognito, any other was carried by a list - unknown
      const setCols = (await getQuery("PRAGMA table_info(hub_hidden_set)")).map((c) => c.name);
      const SET_DDL = `CREATE TABLE IF NOT EXISTS hub_hidden_set (h TEXT NOT NULL, kind TEXT NOT NULL, since INTEGER NOT NULL, src TEXT NOT NULL,
                       PRIMARY KEY (h, kind))`;
      if (setCols.length && !setCols.includes("kind")) {
        await tx(async () => {
          await runQuery("DROP TABLE IF EXISTS hub_hidden_set_v0");
          await runQuery("ALTER TABLE hub_hidden_set RENAME TO hub_hidden_set_v0");
          await runQuery(SET_DDL);
          await runQuery(`INSERT OR IGNORE INTO hub_hidden_set (h, kind, since, src)
                          SELECT h, CASE WHEN src IN ('web', 'report') THEN 'incognito' ELSE 'unknown' END, since,
                                 CASE WHEN src IN ('web', 'report') THEN src ELSE 'pepe' END FROM hub_hidden_set_v0`);
          await runQuery("DROP TABLE hub_hidden_set_v0");
        });
      } else await runQuery(SET_DDL);
      await runQuery("CREATE TABLE IF NOT EXISTS hub_hidden_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL)");
      // manual = 1: never released on its own - an owner un-hid one of its hashes, or it was merged; prev_ts / sent_ts: Pepe's
      // `sent` of the list before the drop and of the first one without them
      await runQuery(`CREATE TABLE IF NOT EXISTS hub_hidden_held (id TEXT PRIMARY KEY, kind TEXT NOT NULL, hs TEXT NOT NULL, at INTEGER NOT NULL,
                      state TEXT NOT NULL, relisted INTEGER NOT NULL DEFAULT 0, decided_at INTEGER, manual INTEGER NOT NULL DEFAULT 0,
                      prev_ts INTEGER, sent_ts INTEGER)`);
      const cols = (await getQuery("PRAGMA table_info(hub_hidden_held)")).map((c) => c.name);   // (a table from before refix 3)
      for (const c of ["prev_ts", "sent_ts"]) if (!cols.includes(c)) await runQuery(`ALTER TABLE hub_hidden_held ADD COLUMN ${c} INTEGER`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** A Pepe list -> the hashes it adds (valid, deduped, capped), or null when it isn't a list. */
function clean(list) {
  if (!Array.isArray(list)) return null;
  const out = new Set();
  for (const x of list) {
    if (cleanHash(x)) out.add(x);
    if (out.size >= MAX) break;
  }
  return out;
}

/**
 * A bridge-sync event -> {hide, h, kind, at, id} for this set, or null: not privacy.hidden / privacy.shown, no valid hash, scope
 * "tx" (another set), or a privacy.shown that doesn't say which kind it un-hides (an un-hide must say what it un-hides: fail
 * closed). A privacy.hidden without a known scope hides as "unknown" (left out).
 * Wire (Pepe CL1): {op: "event", id, ts, type: "privacy.hidden" | "privacy.shown", scope: {platform}, data: {h, scope}}.
 */
function cleanEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  const hide = ev.type === "privacy.hidden" ? true : ev.type === "privacy.shown" ? false : null;
  if (hide === null) return null;
  const d = ev.data && typeof ev.data === "object" ? ev.data : {};
  const h = cleanHash(d.h);
  if (!h || d.scope === "tx") return null;
  const kind = SCOPE_KIND[d.scope] || null;
  if (!hide && !kind) return null;
  const id = typeof ev.id === "string" && ev.id && ev.id.length <= 200 ? ev.id : null;
  return { hide, h, kind: kind || "unknown", at: ms(ev.ts), id };   // at: Pepe's time of the change (his clock), when the event says
}

// ── the sticky set (memory) ──
const ROWS = new Map();          // h -> Map kind -> {src, pts, seen}: pts = Pepe's ms of the newest hide of that kind, seen = when
                                 //   it arrived (our ms) - memory only (a late post can't outlive a site restart: its request dies)
const REMOVED = new Set();       // "kind:h" explicitly removed since boot (and not hidden again): the only stored rows a write deletes
const CAND = new Map();          // h -> {from, first}: an older Pepe's unknown row absent from ONE whole list of the run - `from`:
                                 //   his `sent` of the list that still had it (null: not known), `first`: of the first without it
const OFFS = new Map();          // h -> {ts, seen}: ts = Pepe's ms of their newest real incognito OFF (explains a drop), seen = when
                                 //   their newest OFF report (any) arrived (our ms: a full list older than it doesn't add them back)
const SEEN = new Set();          // privacy.shown event ids taken
const HELD = new Map();          // id -> {id, kind, hs: Set, at, from, sent, state, relisted, manual, decided_at, v, sv}
const HELD_OF = new Map();       // h -> the open batch holding its unknown row (a hash is in one open batch at most)
const RECHECK = new Set();       // "mass" batches an explicit un-hide shrank: release the last hash? (settle)
let LAST = null;                 // the list the next one is compared with: {session, sent, at, whole, explicit, kinded, set, seq,
                                 //   restored, fromless, examined} (sent: Pepe's ms; at: when it arrived, our ms - never compared)
let SAVED = null;                // what hub_hidden_meta 'last' holds (or is about to): the same shape
const RUNS = [];                 // Pepe's recent bridge sessions, oldest first: the last one is his current run (stored with 'last')
let WATCH = null;                // while an owner's decision commits: the rows hidden again meanwhile ("kind:h" - they stay)
let seq = 0;                     // lists taken since boot
let ver = 0, savedVer = -1;      // bumped by every change a write has to store
let lastV = 0, lastSV = 0, offV = 0, offSV = 0;
let DSTORED = null;              // hub_hidden_set as stored: Map "kind:h" -> src (null = read it)
const TICK = { added: 0, removed: 0 };   // hashes newly hidden / fully un-hidden (each call reads the difference)
// untimed: lists without a usable `sent` (they only add); back: lists of one run that came out of order (his clock went back,
// or a late post); stale: lists of an older run; late: un-hides ignored as a late post; dup: privacy.shown resends ignored;
// resolved: unknown rows a kinded Pepe's lists accounted for; skew: the newest list's `sent` minus when it arrived (shown only)
const STATS = { older: 0, released: 0, untimed: 0, back: 0, stale: 0, late: 0, dup: 0, resolved: 0, skew: null, pepe: null };
let capWarned = false;
let clockWarned = false;

const changed = () => { ver++; };
const candChanged = () => { lastV++; ver++; };   // the hashes absent once are stored with 'last'
const keyOf = (kind, h) => kind + ":" + h;
const has = (h, kind) => { const m = ROWS.get(h); return !!(m && m.has(kind)); };
const rowOf = (h, kind) => { const m = ROWS.get(h); return (m && m.get(kind)) || null; };
/** Left out (its lines dropped, not anonymised): hidden by !bridge hide, or by an older Pepe's list (unknown - fail closed). */
const leftOutH = (h) => { const m = ROWS.get(h); return !!(m && (m.has("bridge") || m.has("unknown"))); };
/** The hub copy's scope: "incognito" when that is the ONLY kind (shown as "someone"), else null (left out). */
const scopeOf = (h) => { const m = ROWS.get(h); return m && m.size === 1 && m.has("incognito") ? "incognito" : null; };
const kindsOf = (h) => { const m = ROWS.get(h); return m ? KINDS.filter((k) => m.has(k)) : []; };
/** Every kind of h explicitly removed (and not hidden again): the hub's row may go. */
const removedHash = (h) => !ROWS.has(h) && KINDS.some((k) => REMOVED.has(keyOf(k, h)));

/**
 * Hidden by `kind`. src: "pepe" (a list / privacy.hidden / a stored row), "report" / "web" (incognito only: Pepe's ON report / a
 * website ON). pts: Pepe's ms of this hide (his clock), when known. A surer src lifts a row's; a newer pts moves it. An unknown
 * row that comes back leaves its held batch (relisted). -> 2 newly hidden hash, 1 a new kind of a hidden one, 0 nothing new
 */
function addRow(h, kind, src = "pepe", pts = null) {
  const k = keyOf(kind, h);
  if (WATCH) WATCH.add(k);
  if (REMOVED.delete(k)) changed();
  let m = ROWS.get(h);
  let fresh = 0;
  if (!m) {
    if (ROWS.size >= SET_MAX) {
      if (!capWarned) { capWarned = true; console.error(`[hubhidden] the hidden set is full (${SET_MAX}) - new hashes are not kept`); }
      return 0;
    }
    m = new Map();
    ROWS.set(h, m);
    fresh = 2;
  }
  const s = kind === "incognito" && (src === "web" || src === "report") ? src : "pepe";
  const t = now();
  const r = m.get(kind);
  if (!r) {
    m.set(kind, { src: s, pts, seen: pts != null ? t : null });
    changed();
    if (fresh) TICK.added++;
    return fresh || 1;
  }
  if (RANK[s] > RANK[r.src]) { r.src = s; changed(); }
  if (pts != null && (r.pts == null || pts >= r.pts)) { r.pts = pts; r.seen = t; }
  if (kind === "unknown") unheld(h, true);
  return 0;
}
/** A stored row (hub_hidden_set) back into the set: the surer of what memory and the row say wins. -> newly hidden hash? */
function restore(h, kind, src) {
  if (REMOVED.has(keyOf(kind, h)) || !KINDS.includes(kind)) return false;
  const s = kind === "incognito" && (src === "web" || src === "report") ? src : "pepe";
  return addRow(h, kind, s, null) === 2;
}
/**
 * One kind of h is un-hidden. at: Pepe's ms of the change behind it (his privacy.shown / OFF report) - what explains a held drop
 * (unheld); relisted: an unknown row a kinded list accounted for (not an un-hide). -> 2 the hash is no longer hidden, 1 another
 * kind still hides it, 0 it wasn't there
 */
function removeRow(h, kind, at = null, relisted = false) {
  const m = ROWS.get(h);
  if (!m || !m.has(kind)) return 0;
  m.delete(kind);
  const k = keyOf(kind, h);
  if (!REMOVED.has(k) && REMOVED.size >= REMOVED_MAX) REMOVED.delete(REMOVED.values().next().value);   // (that row then stays: fail closed)
  REMOVED.add(k);
  if (kind === "unknown") { if (CAND.delete(h)) lastV++; unheld(h, relisted, at); }
  changed();
  if (m.size) return 1;
  ROWS.delete(h);
  TICK.removed++;
  return 2;
}
/** Pepe's word at `at` (his ms) explains why a hash vanished between `from` (the list that still had it) and `sent` (the first
 *  without it). */
const inWindow = (at, from, sent) => at != null && from != null && sent != null && at > from && at <= sent;
const explains = (b, at) => inWindow(at, b.from, b.sent);
/** His own real incognito OFF explains why an older Pepe's list lost h in that window. */
const offExplains = (h, from, first) => { const o = OFFS.get(h); return !!(o && inWindow(o.ts, from, first)); };
/**
 * A held hash's unknown row is hidden again (relisted, or accounted for) or un-hidden: it leaves its batch. `at`: Pepe's ms of the
 * change behind the un-hide, null for an owner's (no evidence). One that doesn't explain the drop makes the batch "manual":
 * nothing then says the others were people rather than a lost state - an owner decides them.
 */
function unheld(h, relisted, at = null) {
  const b = HELD_OF.get(h);
  if (!b) return;
  HELD_OF.delete(h);
  b.hs.delete(h);
  if (relisted) b.relisted = true;
  else if (!explains(b, at)) b.manual = true;
  if (!b.hs.size) b.state = "void";
  else if (b.kind === "mass" && !b.relisted && !b.manual) RECHECK.add(b.id);
  b.v++; changed();
}
const KIND_TEXT = { restart: "across his restart", mass: "too many at once", legacy: "hidden before he knew the kinds, and in neither of his lists now" };
/** Held for an owner (their unknown rows). from / sent: Pepe's `sent` of the list that still had them and of the first without
 *  them (null: not comparable). */
function hold(kind, hs, from = null, sent = null) {
  const fresh = hs.filter((h) => !HELD_OF.has(h) && has(h, "unknown"));
  if (!fresh.length) return 0;
  const open = [...HELD.values()].filter((b) => b.state === "pending");
  let b = open.length >= HELD_OPEN_MAX ? open.filter((x) => x.kind === kind).pop() || open[open.length - 1] : null;
  if (b) b.manual = true;                               // merged (too many open): hashes from different lists - no evidence alone
  else {
    b = { id: crypto.randomBytes(6).toString("hex"), kind, hs: new Set(), at: now(), from, sent, state: "pending", relisted: false, manual: false,
          decided_at: null, v: 1, sv: 0 };
    HELD.set(b.id, b);
  }
  for (const h of fresh) { b.hs.add(h); HELD_OF.set(h, b); }
  b.v++; changed();
  console.error(`[hubhidden] ${fresh.length} hash(es) vanished from Pepe's list (${KIND_TEXT[kind] || kind}) - held for an owner on /admin/keys#seam, batch ${b.id} (they stay hidden)`);
  return fresh.length;
}
/** A "mass" batch whose other hashes were all explained (see unheld): its last one is a lone !bridge show - its unknown row goes,
 *  as a single drop's would. */
function settle() {
  for (const id of RECHECK) {
    const b = HELD.get(id);
    if (!b || b.state !== "pending" || b.kind !== "mass" || b.relisted || b.manual || b.hs.size !== 1) continue;
    const hs = [...b.hs];
    b.state = "released"; b.decided_at = now(); b.v++;
    for (const h of hs) { HELD_OF.delete(h); if (removeRow(h, "unknown")) STATS.released++; }
  }
  RECHECK.clear();
}
/** quotes.js keeps its own copy (it never names anyone in it; left-out lines are dropped) - handed over on every change. */
function push() {
  try {
    const all = [...ROWS.keys()];
    require("./quotes").setHidden(all, all.filter(leftOutH));
  } catch (e) { console.error("[hubhidden] quotes:", e.message); }
  // Train 3 review: the pad chat's readers take the stricter of this set and the archive's (chatlogview.kindNow) - its hidden-names
  // job and open pages' privacy digest follow a change here too (a no-op until chatlogview has started)
  try { require("./chatlogview").hubChanged(); } catch (e) { console.error("[hubhidden] chat view:", e.message); }
}
/** An un-hide of `kind` dated `ts` (his clock) older than a hide of that kind that arrived in the last STALE_MS: a late post. */
function lateRemoval(h, kind, ts) {
  const r = rowOf(h, kind);
  return !!(r && r.pts != null && ts != null && ts < r.pts && r.seen != null && now() - r.seen < STALE_MS);
}
function noteOff(h, ts, real) {
  const o = OFFS.get(h) || { ts: null, seen: null };
  o.seen = now();
  if (real && ts != null && (o.ts == null || ts > o.ts)) { o.ts = ts; offV++; changed(); }
  OFFS.delete(h);
  if (OFFS.size >= OFFS_MAX) OFFS.delete(OFFS.keys().next().value);
  OFFS.set(h, o);
}
function seenAdd(id) {
  if (SEEN.size >= SEEN_MAX) SEEN.delete(SEEN.values().next().value);
  SEEN.add(id);
}
function setLast(next) {
  LAST = next;
  const S = SAVED;
  if (!S || S.session !== next.session || S.whole !== next.whole || S.explicit !== next.explicit || S.kinded !== next.kinded
      || S.set.size !== next.set.size || [...next.set].some((h) => !S.set.has(h))) {
    SAVED = next; lastV++; changed();
  }
}
/** Pepe's clock against ours - shown on the seam card only (nothing decides by it). */
function noteSkew(ts) {
  STATS.skew = ts - now();
  const far = Math.abs(STATS.skew) >= CLOCK_WARN_MS;
  if (far && !clockWarned) console.error(`[hubhidden] Pepe's clock is ${Math.round(STATS.skew / 1000)} s ${STATS.skew > 0 ? "ahead of" : "behind"} the site's (nothing here depends on it)`);
  clockWarned = far;
}
/** The tighter window of several (Pepe's ms): the latest `from`, the earliest `first`. */
function windowOf(cs) {
  let from = null, first = null;
  for (const c of cs) {
    if (c.from == null || c.first == null) return [null, null];
    if (from == null || c.from > from) from = c.from;
    if (first == null || c.first < first) first = c.first;
  }
  return [from, first];
}

/** An older Pepe's whole, in-order list of the same run (L, sent ts): what it lacks of his previous list. -> how many held */
function dropStep(L, ts) {
  // (a stored list's `sent` may be older than the list really before it; one that came out of order explains nothing)
  const from = LAST.restored || LAST.fromless ? null : LAST.sent;
  // absent before and absent again: a second whole list in a row without them (one short list un-hides nobody)
  const confirmed = [];
  for (const [h, c] of [...CAND]) {
    if (L.has(h) || !has(h, "unknown")) { CAND.delete(h); candChanged(); continue; }
    confirmed.push([h, c]);
  }
  for (const [h] of confirmed) CAND.delete(h);
  if (confirmed.length) candChanged();
  // newly absent: explained by his own OFF report -> gone now; else absent once
  for (const h of LAST.set) {
    if (L.has(h) || !has(h, "unknown") || CAND.has(h) || confirmed.some((x) => x[0] === h)) continue;
    if (offExplains(h, from, ts)) { removeRow(h, "unknown", OFFS.get(h).ts); STATS.older++; continue; }
    CAND.set(h, { from, first: ts }); candChanged();
  }
  const un = [];
  for (const [h, c] of confirmed) {
    if (offExplains(h, c.from, c.first)) { removeRow(h, "unknown", OFFS.get(h).ts); STATS.older++; } else un.push([h, c]);
  }
  if (!un.length) return 0;
  if (tooMany(un.length, ROWS.size)) {                // a lost state, not people
    const [f, s] = windowOf(un.map((x) => x[1]));
    return hold("mass", un.map((x) => x[0]), f, s);
  }
  for (const [h] of un) { removeRow(h, "unknown"); STATS.older++; }
  return 0;
}
/** An older Pepe's previous run's last list (and what it lacked once) against his new run's first whole list L: a !bridge show just
 *  before the restart, or a state file that failed to load - held, unless his OFF report explains it. -> how many held */
function restartStep(L, ts) {
  const from = LAST.restored || LAST.fromless ? null : LAST.sent;
  const fromLast = [], fromCand = [];
  for (const h of LAST.set) {
    if (L.has(h) || !has(h, "unknown") || CAND.has(h)) continue;
    if (offExplains(h, from, ts)) removeRow(h, "unknown", OFFS.get(h).ts); else fromLast.push(h);
  }
  const cs = [];
  for (const [h, c] of CAND) {
    if (L.has(h) || !has(h, "unknown")) continue;
    if (offExplains(h, c.from, c.first)) removeRow(h, "unknown", OFFS.get(h).ts); else { fromCand.push(h); cs.push(c); }
  }
  CAND.clear(); candChanged();
  let n = hold("restart", fromLast, from, ts);
  if (fromCand.length) { const [f, s] = windowOf(cs); n += hold("restart", fromCand, f, s); }
  return n;
}
/** A kinded Pepe's vouched lists (both whole): an unknown row they account for becomes those kinds (the rows were added before
 *  this); one neither carries is held once ("legacy") - unless his mixed list of the same sync still carries it (kept). */
function resolveStep(L, LB, LI) {
  const legacy = [];
  for (const [h, m] of [...ROWS]) {
    if (!m.has("unknown")) continue;
    if (LB.has(h) || LI.has(h)) { removeRow(h, "unknown", null, true); STATS.resolved++; }
    else if (!(L && L.has(h)) && !HELD_OF.has(h)) legacy.push(h);
  }
  if (CAND.size) { CAND.clear(); candChanged(); }
  return legacy.length ? hold("legacy", legacy) : 0;
}

/**
 * One sync's lists + events -> the set. meta: {session, sent, explicit} - Pepe's bridge session (one per process), when he built the
 * payload (his clock), and whether this Pepe sends privacy.shown (CL1; bridge.js: the sync carries tx_hidden_h).
 * -> {added, removed, held} (added / removed: hashes newly hidden / no longer hidden at all)
 * Until the start-up read worked (bootDone) a list only adds: there is nothing trustworthy to compare it with, and taking it as the
 * list the next one is compared with would overwrite the stored one.
 */
function take({ list, bridge, incog, events, session = null, sent = null, explicit = false } = {}) {
  const trusted = bootDone;
  const a0 = TICK.added, r0 = TICK.removed;
  const L = clean(list), LB = clean(bridge), LI = clean(incog);
  const kinded = !!(LB || LI);
  const anyList = !!(L || LB || LI);
  const ts = ms(sent);                                // Pepe's clock: compared only with his other times
  const sess = typeof session === "string" && session && session.length <= 64 ? session : null;
  // which run of Pepe sent it: his current one ("cur"), a NEW one (he restarted), or an older one whose post arrived late ("stale":
  // it only adds - its privacy.shown events too are taken as nothing)
  const cur = RUNS.length ? RUNS[RUNS.length - 1] : null;
  const run = !sess ? null : sess === cur ? "cur" : RUNS.includes(sess) ? "stale" : "new";
  const listed = (h) => !!((L && L.has(h)) || (LB && LB.has(h)) || (LI && LI.has(h)));
  // what the lists say: everyone in them is hidden now (fail closed) - by the kind his kinded lists give, else "unknown"
  const hides = new Map();                            // "kind:h" -> {h, kind, pts}
  if (LB) for (const h of LB) hides.set(keyOf("bridge", h), { h, kind: "bridge", pts: ts });
  if (LI) for (const h of LI) hides.set(keyOf("incognito", h), { h, kind: "incognito", pts: ts });
  if (L) for (const h of L) if (!(LB && LB.has(h)) && !(LI && LI.has(h))) hides.set(keyOf("unknown", h), { h, kind: "unknown", pts: ts });
  // the events, in order (the later word on one kind of one hash wins)
  const evs = Array.isArray(events) ? events : [];
  const ops = new Map();
  for (let i = 0; i < evs.length && i < EVENTS_MAX; i++) {
    const e = cleanEvent(evs[i]);
    if (e) { ops.delete(keyOf(e.kind, e.h)); ops.set(keyOf(e.kind, e.h), e); }
  }
  const shows = [];
  for (const [k, e] of ops) {
    if (e.hide) { if (!hides.has(k)) hides.set(k, { h: e.h, kind: e.kind, pts: e.at }); continue; }
    if (run === "stale") continue;                    // a late post of an older run only adds
    if (e.id) { if (SEEN.has(e.id)) { STATS.dup++; continue; } seenAdd(e.id); }   // a resend (at-least-once): taken already
    if (hides.has(k)) continue;                       // the same sync's list of that kind still carries it: hidden now
    shows.push(e);
    // nothing in Pepe hides them now (no list of this sync carries the hash): an older list's unknown row goes too
    if (anyList && !listed(e.h) && !hides.has(keyOf("unknown", e.h))) shows.push({ ...e, kind: "unknown" });
  }
  for (const x of hides.values()) addRow(x.h, x.kind, "pepe", x.pts);
  const late = new Set();                             // (counted once per event)
  for (const e of shows) {
    if (lateRemoval(e.h, e.kind, e.at)) { late.add(e.id || e); continue; }
    removeRow(e.h, e.kind, e.at != null ? e.at : ts);
  }
  STATS.late += late.size;
  let held = 0;
  if (anyList) {
    seq++;
    if (ts == null) STATS.untimed++; else noteSkew(ts);
    if (run === "stale") STATS.stale++;
    const usable = ts != null && run !== "stale";      // can be compared with
    const wholeOf = (raw) => (explicit || kinded ? raw.length <= MAX : raw.length < TRUNC);
    const wholeL = !!L && wholeOf(list);
    const same = !!(LAST && run !== "new" && LAST.session === sess);   // the run of the list taken last
    const later = usable && (!LAST || LAST.sent == null || ts >= LAST.sent);
    if (usable && same && !later) STATS.back++;       // out of order: his clock went back, or a late post - compared with nothing
    STATS.pepe = kinded ? "kinded" : explicit ? "explicit" : "older";
    if (trusted && usable) {
      const prevOlder = !!(LAST && LAST.session && !LAST.explicit && !LAST.kinded);
      // a Pepe that knows the kinds: his unknown rows are accounted for once per run (and when he first sends kinds)
      let examined = !!(LAST && LAST.kinded && LAST.examined && run !== "new");
      if (kinded) {
        if (LB && LI && wholeOf(bridge) && wholeOf(incog) && !examined) { held += resolveStep(L, LB, LI); examined = true; }
      } else if (L && wholeL && sess) {
        if (!explicit && same && later && LAST && LAST.session) held += dropStep(L, ts);   // (a CL1 Pepe un-hides by privacy.shown only)
        else if (run === "new" && prevOlder) held += restartStep(L, ts);
      }
      if (run === "new") {
        if (CAND.size) { CAND.clear(); candChanged(); }
        RUNS.push(sess); if (RUNS.length > RUNS_MAX) RUNS.shift();
      }
      // one that came out of order is compared with nothing, but the next is compared with it (the newest that arrived: a clock
      // that went back must not pin the comparison to a list dated ahead) - together with what the list before it had, so nothing
      // it lacked is skipped; and no window from it explains a drop (fromless: two lists decide)
      const own = L || new Set([...(LB || []), ...(LI || [])]);
      const back = !!(same && !later && LAST);
      const set = back ? new Set([...LAST.set, ...own]) : own;
      setLast({ session: sess, sent: ts, at: now(), whole: kinded ? true : wholeL, explicit: !!explicit || kinded, kinded, set, seq, restored: false,
                fromless: back, examined: kinded && examined });
    }
  }
  settle();
  return { added: TICK.added - a0, removed: TICK.removed - r0, held };
}

// ── the stored copies: hub_hidden_set (always) + hub_hidden_h (the hub's, only while hubseam.privacy is on) ──
let last = null;                 // hub_hidden_h as stored: Map h -> scope (null = read it, take it into the set, write the whole set)
let gen = 0;                     // _forget() bumps it: a write in flight then doesn't record what it saw
let chain = Promise.resolve();   // every database step of this module, in order
let queued = null;               // the write every caller arriving before it starts shares
const privacyOn = () => { try { return require("./huboutbox").on("privacy"); } catch (e) { return false; } };
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}
/** hub_hidden_h -> Map h -> scope */
const readHub = async () => {
  const out = new Map();
  for (const r of await db().getQuery("SELECT h, scope FROM hub_hidden_h")) {
    const h = cleanHash(r && r.h);
    if (h) out.set(h, r.scope === "incognito" ? "incognito" : null);
  }
  return out;
};
/** hub_hidden_set -> Map "kind:h" -> src */
const readStored = async () => {
  const out = new Map();
  for (const r of await db().getQuery("SELECT h, kind, src FROM hub_hidden_set")) {
    const h = cleanHash(r && r.h);
    if (h && KINDS.includes(r.kind)) out.set(keyOf(r.kind, h), r.kind === "incognito" && (r.src === "web" || r.src === "report") ? r.src : "pepe");
  }
  return out;
};
const splitKey = (k) => { const i = k.indexOf(":"); return [k.slice(0, i), k.slice(i + 1)]; };

const HELD_UPSERT = `INSERT INTO hub_hidden_held (id, kind, hs, at, state, relisted, decided_at, manual, prev_ts, sent_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET hs = excluded.hs, state = excluded.state, relisted = excluded.relisted, decided_at = excluded.decided_at,
  manual = excluded.manual`;
/** A held batch's row (HELD_UPSERT's values). */
const heldRow = (b, state, decidedAt) => [b.id, b.kind, JSON.stringify([...b.hs]), b.at, state, b.relisted ? 1 : 0, decidedAt == null ? null : decidedAt,
  b.manual ? 1 : 0, b.from == null ? null : b.from, b.sent == null ? null : b.sent];
const lastJson = () => JSON.stringify({ session: SAVED.session, sent: SAVED.sent, whole: SAVED.whole, explicit: SAVED.explicit, kinded: !!SAVED.kinded,
  set: [...SAVED.set], runs: [...RUNS], cand: [...CAND].map(([h, c]) => [h, c.from, c.first]) });

async function flush() {
  await init();
  const { runQuery, getQuery, tx } = db();
  const g = gen;
  if (!DSTORED) {                                     // (a failed boot): what is stored stays hidden
    const dur = await readStored();
    let n = 0;
    for (const [k, src] of dur) { const [kind, h] = splitKey(k); if (restore(h, kind, src)) n++; }
    DSTORED = dur;
    if (n) push();
  }
  const hubOn = privacyOn();
  let hub = hubOn ? last : null;
  if (hubOn && !hub) {                                // first write after a boot or a switch-on: what the hub has stays hidden
    hub = await readHub();
    let n = 0;
    for (const h of hub.keys()) if (!ROWS.has(h) && !removedHash(h) && addRow(h, "unknown", "pepe") === 2) n++;
    if (n) push();
  }
  const v = ver;                                      // (after the reads above took their rows in: this write stores them)
  const dur = DSTORED;
  const dAdd = [], dSrc = [];
  for (const [h, m] of ROWS) {
    for (const [kind, r] of m) {
      const k = keyOf(kind, h);
      if (!dur.has(k)) dAdd.push([h, kind, r.src]); else if (dur.get(k) !== r.src) dSrc.push([h, kind, r.src]);
    }
  }
  const dDel = [...dur.keys()].filter((k) => REMOVED.has(k) && !has(splitKey(k)[1], splitKey(k)[0]));   // never a row just because a list lacks it
  const hAdd = [], hUpd = [], hDel = [];
  if (hub) {
    for (const h of ROWS.keys()) {
      const s = scopeOf(h);
      if (!hub.has(h)) hAdd.push([h, s]); else if (hub.get(h) !== s) hUpd.push([h, s]);
    }
    for (const h of hub.keys()) if (removedHash(h)) hDel.push(h);
  }
  // the meta rows only once the start-up read is back: until then memory has only part of them (it would overwrite the rest)
  const metaOk = bootDone;
  const lv = lastV, ov = offV;
  const meta = [];
  if (metaOk && lv !== lastSV && SAVED) meta.push(["last", lastJson()]);
  if (metaOk && ov !== offSV) meta.push(["offs", JSON.stringify([...OFFS].filter(([, o]) => o.ts != null).map(([h, o]) => [h, o.ts]))]);
  const heldRows = [...HELD.values()].filter((b) => b.v !== b.sv).map((b) => ({ b, v: b.v, row: heldRow(b, b.state, b.decided_at) }));
  const hubDiff = !!(hAdd.length || hUpd.length || hDel.length);
  if (!dAdd.length && !dSrc.length && !dDel.length && !hubDiff && !meta.length && !heldRows.length) {
    if (v === ver && metaOk) savedVer = v;
    if (hub && g === gen) last = hub;
    return hubOn ? { added: 0, removed: 0 } : { ignored: true };
  }
  const t = now();
  let hubWrote = false;
  await tx(async () => {
    for (const k of dDel) { const [kind, h] = splitKey(k); await runQuery("DELETE FROM hub_hidden_set WHERE h = ? AND kind = ?", [h, kind]); }
    for (const [h, kind, s] of dAdd) {
      await runQuery("INSERT INTO hub_hidden_set (h, kind, since, src) VALUES (?, ?, ?, ?) ON CONFLICT(h, kind) DO UPDATE SET src = excluded.src", [h, kind, t, s]);
    }
    for (const [h, kind, s] of dSrc) await runQuery("UPDATE hub_hidden_set SET src = ? WHERE h = ? AND kind = ?", [s, h, kind]);
    if (hubDiff) {
      // the switch can go off between the call and this transaction (setSettings empties the table in its own): the hub's copy
      // stores nothing then
      const sw = (await getQuery("SELECT value FROM hubseam_settings WHERE key = 'privacy'"))[0];
      if (sw && sw.value === "true") {
        for (const h of hDel) await runQuery("DELETE FROM hub_hidden_h WHERE h = ?", [h]);
        for (const [h, s] of hAdd) await runQuery("INSERT INTO hub_hidden_h (h, since, scope) VALUES (?, ?, ?) ON CONFLICT(h) DO UPDATE SET scope = excluded.scope", [h, t, s]);
        for (const [h, s] of hUpd) await runQuery("UPDATE hub_hidden_h SET scope = ? WHERE h = ?", [s, h]);
        hubWrote = true;
      }
    }
    for (const [k, val] of meta) {
      await runQuery("INSERT INTO hub_hidden_meta (key, value, updated) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated", [k, val, t]);
    }
    for (const { row } of heldRows) await runQuery(HELD_UPSERT, row);
  });
  for (const k of dDel) dur.delete(k);
  for (const [h, kind, s] of dAdd) dur.set(keyOf(kind, h), s);
  for (const [h, kind, s] of dSrc) dur.set(keyOf(kind, h), s);
  if (metaOk) { lastSV = lv; offSV = ov; }
  for (const { b, v: bv } of heldRows) {
    b.sv = bv;
    if (b.state !== "pending" && b.v === b.sv) HELD.delete(b.id);   // decided / void and stored: out of memory
  }
  if (v === ver && metaOk) savedVer = v;
  if (hub) {
    if (hubWrote || !hubDiff) {
      if (g === gen) { for (const h of hDel) hub.delete(h); for (const [h, s] of hAdd) hub.set(h, s); for (const [h, s] of hUpd) hub.set(h, s); last = hub; }
    } else { last = null; return { ignored: true }; }
  }
  return hubOn ? { added: hAdd.length, removed: hDel.length } : { ignored: true };
}

/** Store what changed (both tables, the meta, held batches). -> a promise of the hub copy's {added, removed} | {ignored: true}
 *  (the switch is off - hub_hidden_set is written all the same). */
function write() {
  if (!queued) queued = serial(() => { queued = null; return flush(); });
  return queued;
}
const settled = () => savedVer === ver && DSTORED && (!privacyOn() || last);

let booted = null;               // the start-up read in flight
let bootAsked = false;           // boot() was called (bridge.register): until it is done the readers hide everyone (loading)
let bootDone = false;
let bootN = 0;
let bootTry = 0;
let bootTimer = null;
const ON_BOOT = [];              // run once the start-up read worked (incognito.js: the website ONs Pepe answered meanwhile)
/**
 * At start-up (bridge.register): hub_hidden_set back into the set and quotes (and hub_hidden_h's rows - the hub's copy, kept while
 * hubseam.privacy is on, from before the durable set existed: unknown), the list Pepe's next one is compared with, his OFF reports
 * that explain drops and the open held batches - so a site restart hides them before Pepe's first sync (his VM may be down) and
 * changes no decision. A row removed in the meantime stays removed. Until it has worked the readers hide EVERYONE (loading()).
 * Never rejects; a failed read is tried again on a timer and on the next call. -> a promise of how many came back (null: failed).
 */
function boot() {
  bootAsked = true;
  if (bootDone) return Promise.resolve(bootN);
  if (!booted) {
    booted = serial(async () => {
      if (bootDone) return bootN;
      await init();
      const { getQuery } = db();
      const dur = await readStored();
      const hubRows = await readHub();
      const meta = {};
      for (const r of await getQuery("SELECT key, value FROM hub_hidden_meta")) meta[r.key] = r.value;
      const held = await getQuery("SELECT id, kind, hs, at, relisted, manual, prev_ts, sent_ts FROM hub_hidden_held WHERE state = 'pending' ORDER BY at");
      // decided batches are kept a while for the record (who decided is in admin_audit), then go
      await db().runQuery("DELETE FROM hub_hidden_held WHERE state <> 'pending' AND COALESCE(decided_at, at) < ?", [now() - HELD_KEEP_MS])
        .catch((e) => console.error("[hubhidden] prune:", e.message));
      // every read worked: take them in
      let n = 0;
      DSTORED = dur;
      for (const [k, src] of dur) { const [kind, h] = splitKey(k); if (restore(h, kind, src)) n++; }
      for (const h of hubRows.keys()) if (!ROWS.has(h) && !removedHash(h) && addRow(h, "unknown", "pepe") === 2) n++;
      if (!LAST && meta.last) {
        try {
          const j = JSON.parse(meta.last);
          const set = new Set((Array.isArray(j.set) ? j.set : []).filter(cleanHash));
          const sent = ms(j.sent);
          if (sent != null) {
            const session = typeof j.session === "string" && j.session && j.session.length <= 64 ? j.session : null;
            LAST = { session, sent, at: null, whole: j.whole === true, explicit: j.explicit === true, kinded: j.kinded === true, set, seq, restored: true, examined: false };
            SAVED = LAST;
            // Pepe's recent runs (his current one last): a late post of an older run is told from a new run
            const runs = (Array.isArray(j.runs) ? j.runs : []).filter((x) => typeof x === "string" && x && x.length <= 64 && x !== session);
            RUNS.length = 0;
            RUNS.push(...runs.slice(-(RUNS_MAX - 1)));
            if (session) RUNS.push(session);
            // the unknown rows his lists lacked once (a second list without them un-hides; one with them clears it)
            for (const x of Array.isArray(j.cand) ? j.cand : []) {
              const h = Array.isArray(x) ? cleanHash(x[0]) : null;
              if (h && has(h, "unknown") && !CAND.has(h)) CAND.set(h, { from: ms(x[1]), first: ms(x[2]) });
            }
          }
        } catch (e) { /* unreadable: the next list starts afresh (nobody is un-hidden by that) */ }
      }
      if (meta.offs) {
        try {
          for (const x of JSON.parse(meta.offs)) {
            const h = Array.isArray(x) ? cleanHash(x[0]) : null;
            const t = Array.isArray(x) ? ms(x[1]) : null;
            if (!h || t == null || OFFS.size >= OFFS_MAX) continue;
            const o = OFFS.get(h);
            if (!o) OFFS.set(h, { ts: t, seen: null }); else if (o.ts == null || o.ts < t) o.ts = t;
          }
        } catch (e) { /* unreadable: a drop is then explained by nothing - two lists or an owner decide it */ }
      }
      for (const r of held) {
        if (!ID_RE.test(String(r.id)) || HELD.has(r.id)) continue;
        let hs = [];
        try { hs = JSON.parse(r.hs); } catch (e) { hs = []; }
        const num = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));
        const b = { id: r.id, kind: HELD_KINDS.includes(r.kind) ? r.kind : "mass", hs: new Set(), at: Number(r.at) || now(),
                    from: num(r.prev_ts), sent: num(r.sent_ts), state: "pending", relisted: !!r.relisted, manual: !!r.manual, decided_at: null, v: 0, sv: 0 };
        const want = Array.isArray(hs) ? hs : [];
        for (const h of want) if (cleanHash(h) && has(h, "unknown") && !HELD_OF.has(h)) { b.hs.add(h); HELD_OF.set(h, b); }
        if (!b.hs.size) b.state = "void";
        if (b.hs.size !== want.length) { b.v = 1; changed(); }   // (un-hidden meanwhile: the stored row follows)
        HELD.set(b.id, b);
      }
      bootDone = true; bootN = n; bootTry = 0;
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
      push();                                         // (also when nothing came back: quotes stop hiding everyone)
      for (const fn of ON_BOOT.splice(0)) {
        Promise.resolve().then(fn).catch((e) => console.error("[hubhidden] after boot:", e.message));
      }
      return n;
    }).catch((e) => {
      booted = null;
      console.error("[hubhidden] boot:", e.message);
      if (!bootTimer) {
        const ms_ = BOOT_RETRY_MS[Math.min(bootTry, BOOT_RETRY_MS.length - 1)];
        bootTry++;
        bootTimer = setTimeout(() => { bootTimer = null; boot(); }, ms_);
        if (bootTimer.unref) bootTimer.unref();
      }
      return null;
    });
  }
  return booted;
}
/** The start-up read was asked for and hasn't worked yet: the readers (quotes.isHidden / isLeftOut) hide everyone meanwhile. */
const loading = () => bootAsked && !bootDone;
/** Run fn once the start-up read is done - or, when it failed, with the read tried again first; still failing, fn runs on what
 *  memory has, and take() then only adds (see there). At once (synchronously) when it is done. -> a promise (never throws
 *  synchronously). */
function afterBoot(fn) {
  if (!bootDone) return boot().then(fn);
  try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
}
/** fn() once the start-up read WORKED (now, when it has). Errors are logged. */
function whenBooted(fn) {
  if (bootDone) return Promise.resolve().then(fn).catch((e) => console.error("[hubhidden] after boot:", e.message));
  ON_BOOT.push(fn);
  boot();
  return null;
}

/**
 * A bridge sync: Pepe's hidden_h (`list`, mixed, add-only), his kinded lists (`bridge` / `incog`, a Pepe that knows the kinds),
 * the sync's events (privacy.hidden / privacy.shown are taken, the rest ignored) and its `session` / `sent` / `explicit` (see
 * take()). The set (and quotes) change before the stored copies are written behind them. -> a promise of {added, removed} (the
 * hub copy's write), {ignored: true} when the sync carried neither a list nor a privacy event, or while hubseam.privacy is off
 * (hub_hidden_set is written all the same). Never throws synchronously.
 */
function noteSync(sync) {
  const s = sync && typeof sync === "object" ? sync : {};
  return afterBoot(() => {
    const { list, bridge, incog, events, session, sent, explicit } = s;
    const v0 = ver;
    take({ list, bridge, incog, events, session, sent, explicit: explicit === true });
    if (ver !== v0) push();
    if (!Array.isArray(list) && !Array.isArray(bridge) && !Array.isArray(incog) && ver === v0) return { ignored: true };
    if (settled()) return privacyOn() ? { added: 0, removed: 0 } : { ignored: true };
    return write();
  });
}
/** Pepe's hidden_h alone (an older caller, tools/hubseam-driver.js). */
const note = (list) => noteSync({ list });

/** After a report changed the set: quotes at once, the stored copies behind it. -> a promise (never rejects). */
function stored(touched) {
  if (touched) push();
  if (settled()) return Promise.resolve(null);
  return write().catch((e) => { console.error("[hubhidden] write:", e.message); return null; });
}

/**
 * Pepe reported incognito OFF for these keys (incognito.sync), `ts` = his ms of the change; changed: false = a no-op (it was off
 * already). Their incognito row goes - linked or not, changed or not: Pepe has them off - unless the report is older (his clock)
 * than an ON of theirs that arrived in the last STALE_MS (a late post: they stay hidden). Their other kinds stay: !bridge hide
 * keeps them left out, and an older Pepe's unknown row goes when his lists drop them (a real change dated between the list that
 * still had them and the first without explains that drop at once, also a held one - spec §3.1). -> a promise of {removed,
 * ignored} (hashes no longer hidden at all; reports ignored as late) - stored before it resolves; never rejects.
 */
function offReported(keys, ts, { changed: chg = true } = {}) {
  return afterBoot(() => {
    const rts = ms(ts);
    const r0 = TICK.removed, v0 = ver;
    let ignored = 0;
    for (const h of hashesOf(keys)) {
      noteOff(h, rts, chg);
      if (has(h, "incognito")) {
        if (lateRemoval(h, "incognito", rts)) { ignored++; STATS.late++; } else removeRow(h, "incognito", rts);
      }
      if (!chg || rts == null || !has(h, "unknown")) continue;
      // an older Pepe's list lacked them once - or they are held: his own word explains it
      const c = CAND.get(h);
      if (c && offExplains(h, c.from, c.first)) { removeRow(h, "unknown", rts); STATS.older++; continue; }
      const b = HELD_OF.get(h);
      if (b && explains(b, rts)) removeRow(h, "unknown", rts);
    }
    settle();
    const removed = TICK.removed - r0;
    return stored(ver !== v0).then(() => ({ removed, ignored }));
  });
}
/** Pepe's incognito OFF report for a login whose state really changed (the older name). */
const unhideReported = (keys, ts) => offReported(keys, ts, { changed: true });

/**
 * Pepe reported incognito ON for these keys (incognito.sync): hidden as incognito at once (the bridge list may not carry them while
 * no room is bridged; a "web" row is now as sure as his report). Never ignored as out of order: an ON that looks older than his
 * last OFF (his clock went back) still hides them - fail closed. -> a promise of {added} (stored before it resolves; never rejects).
 */
function hiddenReported(keys, ts) {
  return afterBoot(() => {
    const rts = ms(ts);
    const a0 = TICK.added, v0 = ver;
    for (const h of hashesOf(keys)) addRow(h, "incognito", "report", rts);
    const added = TICK.added - a0;
    return stored(ver !== v0).then(() => ({ added }));
  });
}

/**
 * Pepe's whole incognito list (incognito.sync `full`, every 10 minutes): each login on it is incognito (adds only - absence
 * un-hides nobody). A login whose OFF report arrived in the last STALE_MS is skipped (a list built before it, posted late).
 * -> a promise of {added} (never rejects)
 */
function fullReported(keys) {
  return afterBoot(() => {
    const a0 = TICK.added, v0 = ver;
    for (const h of hashesOf(keys)) {
      const o = OFFS.get(h);
      if (o && o.seen != null && now() - o.seen < STALE_MS) continue;
      addRow(h, "incognito", "report", null);
    }
    const added = TICK.added - a0;
    return stored(ver !== v0).then(() => ({ added }));
  });
}

/**
 * A website Incognito ON request (incognito.request): hidden as incognito at once, before Pepe confirms (spec §3.1, src web) -
 * provisional: Pepe's report of it, a list or the action's outcome (webSettled) confirms it or undoes it. -> a promise of {added}
 * (never rejects).
 */
function hideNow(keys, src = "web") {
  return afterBoot(() => {
    const a0 = TICK.added, v0 = ver;
    for (const h of hashesOf(keys)) addRow(h, "incognito", src === "report" ? "report" : "web", null);
    const added = TICK.added - a0;
    return stored(ver !== v0).then(() => ({ added }));
  });
}

/**
 * What became of a website Incognito ON (incognito.actionsSettled, from actions.js's ack and actionttl.js's expiry sweep, once no
 * other ON of theirs is still open; and at start-up for outcomes the site missed). ok: Pepe applied it - a "web" incognito row is
 * now as sure as his own report. Not ok (refused, or expired before he claimed it): a "web" incognito row goes - they never were
 * incognito in Pepe, and Settings shows them OFF. -> a promise of {removed} (never rejects).
 */
function webSettled(keys, ok) {
  return afterBoot(() => {
    const r0 = TICK.removed, v0 = ver;
    for (const h of hashesOf(keys)) {
      const r = rowOf(h, "incognito");
      if (!r || r.src !== "web") continue;
      if (ok) { r.src = "report"; changed(); } else removeRow(h, "incognito");
    }
    const removed = TICK.removed - r0;
    return stored(ver !== v0).then(() => ({ removed }));
  });
}

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.refuse = true; this.code = code; } }

/** The owner form's key: {h} (20 hex) or {login} (a chat login or "u:<userId>", a leading @ dropped) -> its hash, else null. */
function keyHash({ login, h } = {}) {
  const key = typeof login === "string" ? login.trim().replace(/^@/, "") : "";
  return cleanHash(typeof h === "string" ? h.trim().toLowerCase() : h) || (key && key.length <= 70 ? hash(key) : null);
}
/**
 * Run an owner's transaction (fn) and say which rows were hidden again WHILE it ran (a list, privacy.hidden, an ON report or
 * request - they arrive outside the serialised chain): those must stay hidden although the transaction deleted them (the next
 * write puts them back). -> the set of "kind:h"
 */
async function watching(fn) {
  const seen = new Set();
  WATCH = seen;
  try { await fn(); } finally { if (WATCH === seen) WATCH = null; }
  return seen;
}

/**
 * An owner's un-hide (/admin/keys#seam - adminkeys.js checks the owner): {login} (a chat login or "u:<userId>") or {h} (20 hex),
 * `kind` (bridge | incognito | unknown | all - the default) and a reason. The audit row (admin_audit "hubseam.unhide": the hash,
 * the kind asked and the kinds it had - never a login) and the stored rows go in ONE transaction; the set and quotes change only
 * after it committed (unless Pepe hid them again meanwhile). If Pepe still lists the hash, his next sync hides it again. It is no
 * evidence about anyone else: a held "mass" batch it shrinks is never released on its own.
 * -> {h, kind, was_hidden, kinds (before), still (kinds left), held (the kind of batch its unknown row was held in, or null)}
 */
async function unhideByOwner({ login, h, kind } = {}, actor, why) {
  const hh = keyHash({ login, h });
  if (!hh) throw new Refuse(400, "Give a chat login or a 20-character hash.", "bad_key");
  const want = kind == null || kind === "" || kind === "all" ? "all" : KINDS.includes(kind) ? kind : null;
  if (!want) throw new Refuse(400, "Un-hide which kind: all, bridge, incognito or unknown?", "bad_kind");
  const reason = String(why == null ? "" : why).trim();
  if (reason.length < 3) throw new Refuse(400, "Give a reason.", "reason");
  if (!actor || !actor.userId) throw new Refuse(403, "Only an owner can do that.", "owner_only");
  await boot();
  const out = await serial(async () => {
    await init();
    const { runQuery, getQuery, tx } = db();
    const before = new Set(kindsOf(hh));
    for (const r of await getQuery("SELECT kind FROM hub_hidden_set WHERE h = ?", [hh])) if (KINDS.includes(r.kind)) before.add(r.kind);
    if (!before.size && privacyOn() && (await getQuery("SELECT 1 AS x FROM hub_hidden_h WHERE h = ?", [hh]))[0]) before.add("unknown");
    const kinds = KINDS.filter((k) => before.has(k) && (want === "all" || k === want));
    const was = kinds.length > 0;
    const heldKind = HELD_OF.has(hh) && kinds.includes("unknown") ? HELD_OF.get(hh).kind : null;
    const again = await watching(() => tx(async () => {
      await require("./adminaudit").record(actor, "hubseam.unhide", null, { h: hh, kind: want, was_hidden: was, kinds: KINDS.filter((k) => before.has(k)) }, reason);   // with the change, never without
      for (const k of kinds) await runQuery("DELETE FROM hub_hidden_set WHERE h = ? AND kind = ?", [hh, k]);
    }));
    // committed: the stored rows as the database has them now; the set follows - unless Pepe hid them again meanwhile. A hub row
    // with no stored kind (hub_hidden_h from before the durable set) counts as unknown
    for (const k of kinds) {
      if (DSTORED) DSTORED.delete(keyOf(k, hh));
      if (again.has(keyOf(k, hh))) { changed(); continue; }   // (its row is gone: the next write puts it back)
      if (!removeRow(hh, k, null)) {
        if (!REMOVED.has(keyOf(k, hh)) && REMOVED.size >= REMOVED_MAX) REMOVED.delete(REMOVED.values().next().value);
        REMOVED.add(keyOf(k, hh)); changed();
      }
    }
    settle();
    push();
    return { h: hh, kind: want, was_hidden: was, kinds: KINDS.filter((k) => before.has(k)), still: kindsOf(hh), held: heldKind };
  });
  await stored(false);
  return out;
}

/**
 * An owner's look-up (/admin/keys#seam, before deciding): is this chat login (or hash) hidden, by which kinds (and how sure), is it
 * absent once from an older Pepe's list, is its unknown row held (the batch's id, kind and time - the page's list). Changes nothing;
 * audited (admin_audit "hubseam.check": the hash only - incognito hides WHO, so even a look-up leaves a trace).
 * -> {h, hidden, left_out, kinds: [{kind, src}], absent_once, held: {id, kind, at} | null}
 */
async function checkByOwner({ login, h } = {}, actor) {
  const hh = keyHash({ login, h });
  if (!hh) throw new Refuse(400, "Give a chat login or a 20-character hash.", "bad_key");
  if (!actor || !actor.userId) throw new Refuse(403, "Only an owner can do that.", "owner_only");
  await boot();
  if (!bootDone) throw new Refuse(503, "The hidden set isn't loaded yet - try again in a minute.", "not_ready");
  await require("./adminaudit").record(actor, "hubseam.check", null, { h: hh }, null);
  const b = HELD_OF.get(hh);
  const m = ROWS.get(hh);
  return { h: hh, hidden: !!m, left_out: leftOutH(hh), kinds: m ? KINDS.filter((k) => m.has(k)).map((k) => ({ kind: k, src: m.get(k).src })) : [],
           absent_once: CAND.has(hh), held: b && b.state === "pending" ? { id: b.id, kind: b.kind, at: b.at } : null };
}

/**
 * An owner's decision on a held batch (/admin/keys#seam): approve = its unknown rows go (someone also incognito stays shown as
 * "someone"; one on !bridge hide stays left out), dismiss = they stay. Audited (admin_audit "hubseam.held": id, kind, how many -
 * never a hash) in the transaction that stores it. A row Pepe hides again while that transaction runs stays.
 * -> {id, approved, removed (unknown rows that went), still_hidden (of those, hidden by another kind)}
 */
async function decideHeld(id, approve, actor, why) {
  const bid = typeof id === "string" ? id.trim().toLowerCase() : "";
  if (!ID_RE.test(bid)) throw new Refuse(400, "No such held change.", "not_found");
  if (typeof approve !== "boolean") throw new Refuse(400, "Approve or dismiss.", "bad");
  const reason = String(why == null ? "" : why).trim();
  if (reason.length < 3) throw new Refuse(400, "Give a reason.", "reason");
  if (!actor || !actor.userId) throw new Refuse(403, "Only an owner can do that.", "owner_only");
  await boot();
  const out = await serial(async () => {
    await init();
    const { runQuery, getQuery, tx } = db();
    const b = HELD.get(bid);
    if (!b) {
      const r = (await getQuery("SELECT state FROM hub_hidden_held WHERE id = ?", [bid]))[0];
      throw r ? new Refuse(409, "That was already decided.", "decided") : new Refuse(404, "No such held change.", "not_found");
    }
    if (b.state !== "pending") throw new Refuse(409, "That was already decided.", "decided");
    const hs = approve ? [...b.hs].filter((h) => has(h, "unknown")) : [];
    const t = now(), state = approve ? "approved" : "dismissed";
    const again = await watching(() => tx(async () => {
      await require("./adminaudit").record(actor, "hubseam.held", null, { id: b.id, kind: b.kind, n: b.hs.size, approve }, reason);
      for (const h of hs) await runQuery("DELETE FROM hub_hidden_set WHERE h = ? AND kind = 'unknown'", [h]);
      await runQuery(HELD_UPSERT, heldRow(b, state, t));    // who decided: admin_audit
    }));
    // committed: memory follows (a row hidden again meanwhile left the batch and stays; the next write restores it)
    for (const h of b.hs) HELD_OF.delete(h);
    b.state = state; b.decided_at = t; b.v++; b.sv = b.v;
    HELD.delete(b.id);
    let removed = 0, still = 0;
    for (const h of hs) {
      if (DSTORED) DSTORED.delete(keyOf("unknown", h));
      if (again.has(keyOf("unknown", h))) { changed(); continue; }   // (its row is gone: the next write puts it back)
      const r = removeRow(h, "unknown", null);
      if (r) { removed++; if (r === 1) still++; }
    }
    if (removed) push();
    return { id: b.id, approved: approve, removed, still_hidden: still };
  });
  await stored(false);
  return out;
}

const isHiddenHash = (h) => ROWS.has(h);
const isLeftOutHash = (h) => leftOutH(h);
/** Train 3 review: every hash hidden here now (chatlogview's hidden-names job: the people whose names inside other lines become
 *  "someone"). Memory only - never a login. */
const hiddenHashes = () => [...ROWS.keys()];
/** For /admin/keys#seam (sizes, counts and held batch ids - never a hash). Every open batch is listed (at most HELD_OPEN_MAX). */
function status() {
  const open = [...HELD.values()].filter((b) => b.state === "pending").sort((a, b) => b.at - a.at);
  const by = { bridge: 0, incognito: 0, unknown: 0 };
  let web = 0, left = 0, anon = 0;
  for (const [h, m] of ROWS) {
    for (const k of m.keys()) by[k]++;
    const i = m.get("incognito");
    if (i && i.src === "web") web++;
    if (leftOutH(h)) left++; else anon++;
  }
  return { size: ROWS.size, left_out: left, anonymised: anon, bridge: by.bridge, incognito: by.incognito, unknown: by.unknown, web,
           absent_once: CAND.size, kept: DSTORED ? DSTORED.size : null, stored: last ? last.size : null, full: ROWS.size >= SET_MAX,
           held: open.reduce((n, b) => n + b.hs.size, 0),
           held_batches: open.slice(0, HELD_OPEN_MAX).map((b) => ({ id: b.id, kind: b.kind, n: b.hs.size, at: b.at,
             other: [...b.hs].filter((h) => (ROWS.get(h) || new Map()).size > 1).length })),
           older_unhid: STATS.older, released: STATS.released, resolved: STATS.resolved, untimed: STATS.untimed, back: STATS.back,
           stale: STATS.stale, late: STATS.late, dup: STATS.dup,
           clock_s: STATS.skew == null ? null : Math.round(STATS.skew / 1000), pepe: STATS.pepe, booted: bootDone };
}

/** The current stored set for the hub (for the privacy/changed snapshot). */
async function all() {
  await init();
  return db().getQuery("SELECT h, since, scope FROM hub_hidden_h ORDER BY h");
}

module.exports = { init, boot, loading, whenBooted, note, noteSync, offReported, unhideReported, hiddenReported, fullReported, hideNow, webSettled,
  unhideByOwner, checkByOwner, decideHeld, isHiddenHash, isLeftOutHash, hiddenHashes, kindsOf, status, all, hash, loginHash, clean, cleanEvent, MAX, SET_MAX,
  TRUNC, HOLD_N, HOLD_PCT, HELD_OPEN_MAX, STALE_MS, KINDS, HASH_RE, LOGIN_RE,
  _forget: () => { last = null; gen++; },          // the hub's table was emptied (the privacy switch went off): re-read on the next write
  /** Tests: a fresh process (memory only - the tables stay). */
  _reset: () => {
    ready = null; last = null; gen++; chain = Promise.resolve(); queued = null; booted = null; bootAsked = false; bootDone = false; bootN = 0; bootTry = 0;
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    LAST = null; SAVED = null; seq = 0; ver = 0; savedVer = -1; lastV = 0; lastSV = 0; offV = 0; offSV = 0; DSTORED = null; WATCH = null;
    ROWS.clear(); REMOVED.clear(); CAND.clear(); OFFS.clear(); SEEN.clear(); HELD.clear(); HELD_OF.clear(); RECHECK.clear();
    RUNS.length = 0; ON_BOOT.length = 0;
    capWarned = false; clockWarned = false;
    Object.assign(STATS, { older: 0, released: 0, untimed: 0, back: 0, stale: 0, late: 0, dup: 0, resolved: 0, skew: null, pepe: null });
  },
  _setClock: (f) => { clock = f || (() => Date.now()); } };
