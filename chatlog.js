// chatlog.js — CL2: the pad chat's durable archive (ships DARK: nothing is written until its switches are on).
//
// v1's pad chat already is a consolidated stream: the bridge feed (bridge.js) interleaves chat lines, 🎙 mic transcripts,
// joins / leaves, mic grabs / drops, the topic and site notices (🎥 go-live, 📼 now playing). bridge.js keeps 200 items per
// room and deletes them when Pepe leaves. This module keeps every item for good (until retention purges it, CL7) in an
// append-only table written from the same ingest, keyed by the same feed cursor `c` - which becomes permanent.
//
//   chatlog_rooms         one row per Camfrog room the archive has seen (rk = the short room key); watermarks (CL3), counters
//   chat_log              one row per item the pad chat showed, in feed order (c = bridge_feed.c, never reused)
//   chat_log_fts          FTS5 over chat_log's own text (external content: the text is stored once; triggers keep it)
//   chatlog_hidden        the STICKY hidden set (hashes): only an explicit un-hide removes one (below)
//   chatlog_tx_hidden     !transcripts off (hashes), the same rules
//   chatlog_private_ever  every hash ever hidden (append-only; the v2 import)
//   chatlog_hidden_held   mass un-hides waiting for an operator (/admin/bridge)
//   chatlog_hidden_names  names to redact for hashes hidden NOW (filled by CL3's job)
//   pad_chat_cfg          per-PAD settings (CL3 writes them; keyed by the pad id, so it moves with the pad - padrekey)
//   chatlog_open / _reports / _holds / _views / _exports   CL3 / CL6 / CL10 (created here so merge / delete / export cover them)
//   chatlog_meta          key/value: the switches ('cfg'), cursor_hw, seed_done, fts_hw
//
// The write path (bridge.ingest / liveNotice -> archiveBatch): bridge_feed is written exactly as before - the live chat never
// depends on the archive. Then, while the chatlog.archive switch is on, the batch's rows of rooms holding the 💎 bridge perk
// (premium.bridgeAllowed) go into ONE dbUtils.tx (a savepoint when called inside one), awaited before Pepe gets his answer,
// inside try/catch: a failure is counted (and logged once a minute); 20 failed batches in a row trip chatlog.archive off and
// the admin card says why. Before a cursor is assigned bridge.js asks dupes(): a 🎙 transcript whose (room, tx id) is already
// archived is skipped (live feed included), and for 10 minutes after boot an event whose id is already archived (eid) is
// skipped, so a restart between processing a batch and answering it can't duplicate lines. Inserts are plain INSERTs: after
// those checks a constraint error is a bug - counted, never swallowed.
// Cursor permanence: cursor_hw is upserted on every sync that wrote items (archive on or off); at boot bridge.js starts from
// max(MAX(bridge_feed.c), MAX(chat_log.c), cursor_hw), so `c` never repeats (?line= links, quotes, clips, the v2 import key).
// Never archived: PMs (message.private never reaches the feed), and commands that carry private text or secrets
// (PRIVATE_ARGS: the site's copy of Pepe's catalog `private_args` list - they don't reach the live feed either).
//
// The sticky hidden set (decision 9; the privacy critique's B1): a hash is ADDED when it appears in any hidden_h list (an older
// Pepe's list is add-only here: absence never removes), in a privacy.hidden {h, scope} event (Pepe CL1), in a website
// Incognito ON request (at once, before Pepe confirms), or from forget-me / account deletion / the staff tool (forget | delete
// | staff, CL6). CL2 fix-up: each hash keeps WHY it is hidden - a set of reasons (chatlog_hidden.scopes, JSON {reason: since}),
// so un-hiding one reason never removes another (and incognito vs !bridge hide stay told apart: the owner's 2026-10-19
// decision-9 change, hiddenKind):
//   bridge            privacy.hidden {scope: bridge} (!bridge hide)                                        kind "out"  (left out)
//   incognito         privacy.hidden {scope: incognito}; Pepe's incognito report / full list               kind "anon"
//   list_b + list_i   hidden_h listed the hash and nothing says why (an older Pepe, people hidden before CL1, an event still on its
//                     way): unknown = BOTH kinds - !bridge show clears list_b, !incognito off list_i       "out"
//   web               a website Incognito ON Pepe hasn't confirmed yet                                     "anon"
//   of:<h>            the account key u:<userId> of a linked account whose login (hash <h>) is incognito - its web lines from
//                     before it linked (cleared with that login's incognito)                               "anon"
//   forget | delete | staff   never removed by Pepe                                                        "out"
// It is REMOVED only by an explicit un-hide: Pepe's privacy.shown {h, scope} (bridge -> bridge + list_b; incognito ->
// incognito + list_i + web + the of:<h> reasons it explains). A list - empty, short, cut - never un-hides anyone. Every reason
// keeps the time it was last asserted, and an un-hide removes only reasons older than itself (Pepe's event time): a stale
// privacy.shown still in Pepe's queue never undoes a newer website ON, and a held batch approved later never undoes a hide that
// came after it. A batch that would WEAKEN more than 5 hashes (un-hide them, or left out -> anonymised) - or 2+ that are more
// than 10 % of the set - is HELD for an operator. !transcripts off (chatlog_tx_hidden; tx_hidden_h add-only, privacy.* {scope:
// tx}) follows the same rules with one reason. Keys are lower-cased before hashing on both sides, u:<userId> included
// (sha256("pepe-hidden:" + key)[:20], hubhidden.hash). The set is loaded at boot, before anything else the module does; until
// it is loaded every key counts as hidden (fail closed: hiddenReady()). It never depends on hubseam.privacy.
//
// The owner's decision-9 change (2026-10-19 - "incognito hides WHO, not WHAT"): the readers ask the KIND, never just "hidden":
//   isLeftOutHash(h) (kind "out": !bridge hide, a kind Pepe never said, forget / delete / staff) -> the line is LEFT OUT everywhere;
//   kind "anon" (incognito only) -> the line is shown as "someone": no login, display name, avatar or looks (chatlogview.dress),
//   search never matches or returns their name, their words are found only without attribution.
// Pepe's KINDED lists (the bot's sync since the owner change: bridge_hidden_h / incog_hidden_h, each null when that state failed
// to load - so a list he sends is one he vouches for) add the `bridge` / `incognito` reason; with BOTH lists whole, a hash that
// only an older list put here (list_b + list_i: kind unknown) is RESOLVED to the kinds they carry (a weakening - left out ->
// "someone" - counts toward the held rule, as kind "resolve"); one neither list carries (nor his mixed hidden_h) is HELD once per
// run as "legacy" (hidden before Pepe knew the kinds and dropped since: only an operator un-hides it).
// ONE set with hubhidden.js (the site branch hubhidden-site, 1.99add refix 4): the same inputs (hidden_h, bridge_hidden_h,
// incog_hidden_h, privacy.* {scope}, a website ON, Pepe's incognito reports), the same reader names (isHiddenHash, isLeftOutHash,
// kindsOf, loading) and the same kinds - hubRows() maps each hash's reasons onto hubhidden's rows (h, kind, since, src):
//   bridge -> bridge · incognito / web / of:<h> -> incognito (src pepe | web) · list_b -> unknown (list_i alone -> incognito: the
//   bridge half was shown) · forget / delete / staff -> "protected" (CL6's; hubhidden has no such kind yet - never removed by Pepe)
// and the held kinds match hubhidden_held's where they mean the same ("legacy"); "shown" / "shown_tx" / "resolve" are this set's
// (hubhidden's "mass" / "restart" are the older-Pepe drop inference this set never makes - a list never un-hides anyone here).
//
// Switches (chatlog_meta 'cfg', JSON, clean on read and write - the padcfg pattern; chatlog_meta is one of the per-environment
// tables keep-staging-tables keeps, so a staging refresh never hands staging prod's switches):
//   notice     (off) starts the 7-day notice: the privacy policy shows the new text; Pepe announces (owner sync `chatlog`)
//   archive    (off) starts writing; refused until NOTICE_DAYS after notice went on; the seed runs at its first switch-on
//   history / search / downloads   (off) CL8 / CL9 / CL10 (chatloghist.js / chatlogsearch.js / chatlogexport.js)
//   purge      (on)  CL7 (the policy text says "deleted once deletion is on" while it is off)
// Admin: the "Chat archive" card on /admin/bridge (GET /api/admin/chatlog + the POSTs below), capability chatlog.admin.
// CL6: takedowns (report / remove / hide / purge, holds, the per-login tool) are chatlogmod.js's; it fills the owner sync's
// `removed` list and reads the small partial index chat_log_rm (taken-down rows only).
// CL7: the retention purge is chatlogpurge.js's nightly pass (the purge switch: on = delete, off = report-only); register() below
// mounts its admin routes (GET / POST /api/admin/chatlog/purge) and starts its hourly check.
// Index health: never FTS5 'rebuild' (on external content it would index removed rows): an incremental drift check every 6 h
// (indexable rows above a high-water mark vs FTS docsize rows), a full check from the admin card, a repair in batches of 5,000
// (each its own transaction, a yield between), search answers partial meanwhile (ftsPartial()).
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { runQuery, getQuery, tx } = require("./dbUtils");

// ── owner decisions (spec §6): each one constant ──
const NOTICE_DAYS = 7;                     // decision 16: the notice runs this long before chatlog.archive may go on
const SEED_AT_SWITCH_ON = true;            // decision 1: the first switch-on copies what bridge_feed holds (<= 200 per room)
const PERK_ROOMS_ONLY = true;              // decision 27: only rooms holding the 💎 bridge perk at write time are archived
// decision 25: "" = the archive tables live in myapp.db; a path = an ATTACHed chatlog.db (chat_log + chat_log_fts only) with its
// own backup cadence - the VPS disk check (spec §7) decides. Set CHATLOG_DB in the site's environment before the first switch-on.
const ARCHIVE_DB = String(process.env.CHATLOG_DB || "").trim();

const DAY = 86400000;
const TRIP_AFTER = 20;                     // failed batches in a row -> chatlog.archive trips off
const HOLD_N = 5, HOLD_PCT = 0.10;         // a batch weakening more than HOLD_N hashes, or 2+ over HOLD_PCT of the set, is held
// CL2 fix-up: list_b / list_i added this long before (or after) a typed privacy.hidden were that very hide, seen in hidden_h
// before its event arrived - the event replaces them; older ones (people hidden before CL1) stay until both kinds are un-hidden
const LIST_RACE_MS = 10 * 60e3;
const BOOT_EID_MS = 10 * 60e3;             // after boot, events missing SEEN_EVENTS are checked against chat_log.eid
const DRIFT_MS = 6 * 3600e3;               // the incremental FTS drift check
const REPAIR_BATCH = 5000;
const LIST_MAX = 20000;                    // hashes taken from one hidden_h list (Pepe CL1 drops his 3,000 cut)
// CL9's search adds the room token (rt) to its FTS query only for rooms holding under this share of the indexed rows
// (chatlog_rooms.idx_rows); bigger rooms post-filter on rk (bench: a common word with the token 135 ms, without it 0.1 ms).
// tools/chatlog-bench.js reports both sides of it.
const RT_SHARE = 0.25;
const TX_LRU_MAX = 5000;
const HASH_RE = /^[0-9a-f]{20}$/;
const PROTECTED = new Set(["forget", "delete", "staff"]);     // never removed by Pepe
const SOURCES = new Set(["pepe", "web", "forget", "delete", "staff"]);
const SCOPES = new Set(["bridge", "incognito", "tx"]);
// CL2 fix-up: the reasons a hash is hidden (the header): which ones leave the lines OUT, which ones Pepe's list / events speak for,
// and what each privacy.shown scope clears
const OUT_REASONS = new Set(["bridge", "list_b", "forget", "delete", "staff"]);
const PEPE_REASONS = new Set(["bridge", "incognito", "list_b", "list_i"]);
const SHOWN_CLEARS = Object.freeze({ bridge: ["bridge", "list_b"], incognito: ["incognito", "list_i", "web"] });
const REASON_RE = /^(bridge|incognito|list_b|list_i|web|forget|delete|staff|of:[0-9a-f]{20})$/;
// the commands whose arguments are private (Pepe's catalog `private_args`, aliases expanded) - never archived, never in the live
// feed. Pepe's help sync can only ADD to this list (privateFromHelp); keep it in step with camfrog-bot help/catalog.json.
const PRIVATE_ARGS = Object.freeze(["!msg", "!message", "!patvmsg", "!verify", "!verifypad", "!joinroom", "!padfine", "!padmove", "!relay", "!tell"]);
const INDEXABLE_KINDS = ["msg", "tx", "topic"];
const INDEXABLE = "text IS NOT NULL AND k IN ('msg','tx','topic') AND rm_at IS NULL AND purged IS NULL";
// the feed item -> d: what isn't a column (c, ts, k, text, the tx id, CL3's aud) and, of `u`, only what renders (login is `who`)
// (owner change: `ah` - an anonymised line's speaker hash, server-only - is the row's who "h:<ah>", never in d. Train 3 review:
// `ahs` - the speaker's other incognito hashes, Pepe's data.anon.hs - is d.ahs, cleaned, only beside a valid `ah`; server-only:
// chatlogview.itemOf reads it back, dress drops it, no export names it)
const ITEM_SKIP = new Set(["c", "ts", "k", "text", "id", "u", "cap", "_job", "aud", "ah", "ahs"]);
const U_KEEP = ["display", "self", "bot", "web", "acct", "unresolved", "anon"];

let clock = () => Date.now();
const now = () => clock();
let BOOT_AT = Date.now();

// ── the tables ──
// Every statement parses in the VPS's sqlite3 CLI 3.31 (no iif(), ->>, unixepoch(), STRICT, RETURNING - test/chatlog-guards).
// MAIN_DDL lives in myapp.db; ARCHIVE_DDL in myapp.db too, or (CHATLOG_DB set) in the attached schema "chatlog".
const MAIN_DDL = [
  `CREATE TABLE IF NOT EXISTS chatlog_rooms (rk INTEGER PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, first_c INTEGER, first_ts INTEGER,
    pad_id TEXT, owner_id TEXT, owner_since INTEGER, owner_grant INTEGER, wm_chat INTEGER NOT NULL DEFAULT 0, wm_tx INTEGER NOT NULL DEFAULT 0,
    wm_search INTEGER NOT NULL DEFAULT 0, aud_m INTEGER NOT NULL DEFAULT 0, exp_chat INTEGER NOT NULL DEFAULT 0, exp_tx INTEGER NOT NULL DEFAULT 0,
    inputs TEXT, rows INTEGER NOT NULL DEFAULT 0, idx_rows INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)`,
  // scopes (CL2 fix-up): JSON {reason: ms last asserted} - why the hash is hidden (the header); NULL on a row from before it
  "CREATE TABLE IF NOT EXISTS chatlog_hidden (h TEXT PRIMARY KEY, since INTEGER NOT NULL, src TEXT NOT NULL, scopes TEXT)",
  "CREATE TABLE IF NOT EXISTS chatlog_tx_hidden (h TEXT PRIMARY KEY, since INTEGER NOT NULL, src TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS chatlog_private_ever (h TEXT PRIMARY KEY, first_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS chatlog_hidden_held (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, hs TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS chatlog_hidden_names (h TEXT PRIMARY KEY, login TEXT NOT NULL, names TEXT NOT NULL, updated INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS pad_chat_cfg (room_id TEXT PRIMARY KEY, window_s INTEGER, search INTEGER, downloads INTEGER, mods_all INTEGER,
    locked INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL, by_user TEXT)`,
  `CREATE TABLE IF NOT EXISTS chatlog_open (id INTEGER PRIMARY KEY, rk INTEGER NOT NULL, scope TEXT NOT NULL, requested INTEGER NOT NULL,
    effective INTEGER NOT NULL, by_user TEXT, state TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS chatlog_reports (id INTEGER PRIMARY KEY, c INTEGER NOT NULL, rk INTEGER NOT NULL, reporter TEXT, reason TEXT NOT NULL,
    note TEXT, state TEXT NOT NULL, created INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER)`,
  "CREATE TABLE IF NOT EXISTS chatlog_holds (key TEXT PRIMARY KEY, by_user TEXT NOT NULL, why TEXT NOT NULL, at INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS chatlog_views (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, rk INTEGER, who TEXT, kind TEXT NOT NULL,
    from_ts INTEGER, to_ts INTEGER, why TEXT, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS chatlog_exports (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, rk INTEGER NOT NULL, from_ts INTEGER, to_ts INTEGER,
    fmt TEXT NOT NULL, sys INTEGER NOT NULL, role TEXT NOT NULL, items INTEGER, bytes INTEGER, state TEXT NOT NULL, created INTEGER NOT NULL,
    tz TEXT, lang TEXT, cut_next INTEGER)`,                     // CL10 fix-up: tz / lang / cut_next (chatlogexport adds them to an older table)
  "CREATE INDEX IF NOT EXISTS chatlog_exports_user ON chatlog_exports (user_id, created)",
  "CREATE TABLE IF NOT EXISTS chatlog_meta (key TEXT PRIMARY KEY, value TEXT)",
  // S1 V4 fix-up: the lines an account deletion's "Also remove my public messages" met under a legal hold or a report (chatlogmod
  // removeAccountLines): taken down, their words deleted by the nightly pass once nothing holds them (ADR 0007 D10's report bounds);
  // `at` = when the removal met them (a report filed after it doesn't hold the line). A line id and a time - nothing else.
  "CREATE TABLE IF NOT EXISTS chatlog_erase_wait (c INTEGER PRIMARY KEY, at INTEGER NOT NULL)",
  // CL6 fix-up: the reports' and the audit's own lookups (a line's open reports, a reporter's limits, the queue, the nightly prunes)
  "CREATE INDEX IF NOT EXISTS chatlog_reports_c ON chatlog_reports (c, state)",
  "CREATE INDEX IF NOT EXISTS chatlog_reports_reporter ON chatlog_reports (reporter, created)",
  "CREATE INDEX IF NOT EXISTS chatlog_reports_state ON chatlog_reports (state, created)",
  "CREATE INDEX IF NOT EXISTS chatlog_views_at ON chatlog_views (at)",
  "CREATE INDEX IF NOT EXISTS chatlog_views_user ON chatlog_views (user_id, at)",
];
const ARCHIVE_DDL = [
  `CREATE TABLE IF NOT EXISTS chat_log (c INTEGER PRIMARY KEY, rk INTEGER NOT NULL, ts INTEGER NOT NULL, k TEXT NOT NULL, who TEXT, text TEXT,
    rt TEXT NOT NULL, aud TEXT NOT NULL, d TEXT NOT NULL, mid TEXT, tx TEXT, eid TEXT, rm_at INTEGER, rm_by TEXT, rm_why TEXT, purged INTEGER)`,
  "CREATE INDEX IF NOT EXISTS chat_log_room ON chat_log (rk, c)",
  "CREATE INDEX IF NOT EXISTS chat_log_room_ts ON chat_log (rk, ts)",
  "CREATE INDEX IF NOT EXISTS chat_log_who ON chat_log (who, c) WHERE who IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS chat_log_tx ON chat_log (rk, tx) WHERE tx IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS chat_log_eid ON chat_log (eid) WHERE eid IS NOT NULL",
  // CL6: the taken-down lines only (a small partial index): the owner sync's removed list per room, the nightly 30-day pass
  "CREATE INDEX IF NOT EXISTS chat_log_rm ON chat_log (rk, rm_at) WHERE rm_at IS NOT NULL",
  // CL6 fix-up: the nightly 30-day pass walks only the taken-down rows whose text is still there (a purged row leaves this index;
  // chat_log_rm keeps every taken-down row for the removed list)
  "CREATE INDEX IF NOT EXISTS chat_log_rm_due ON chat_log (rm_at) WHERE rm_at IS NOT NULL AND purged IS NULL",
];
const FTS_DDL = "CREATE VIRTUAL TABLE IF NOT EXISTS chat_log_fts USING fts5(text, rt, content = 'chat_log', content_rowid = 'c', tokenize = 'unicode61 remove_diacritics 2')";
const TRIGGERS = [
  ["chat_log_ai", `CREATE TRIGGER IF NOT EXISTS chat_log_ai AFTER INSERT ON chat_log
    WHEN new.text IS NOT NULL AND new.k IN ('msg','tx','topic') AND new.rm_at IS NULL AND new.purged IS NULL BEGIN
    INSERT INTO chat_log_fts (rowid, text, rt) VALUES (new.c, new.text, new.rt); END`],
  ["chat_log_ad", `CREATE TRIGGER IF NOT EXISTS chat_log_ad AFTER DELETE ON chat_log
    WHEN old.text IS NOT NULL AND old.k IN ('msg','tx','topic') AND old.rm_at IS NULL AND old.purged IS NULL BEGIN
    INSERT INTO chat_log_fts (chat_log_fts, rowid, text, rt) VALUES ('delete', old.c, old.text, old.rt); END`],
  ["chat_log_au", `CREATE TRIGGER IF NOT EXISTS chat_log_au AFTER UPDATE OF text, rt, rm_at, purged ON chat_log BEGIN
    INSERT INTO chat_log_fts (chat_log_fts, rowid, text, rt)
      SELECT 'delete', old.c, old.text, old.rt
      WHERE old.text IS NOT NULL AND old.k IN ('msg','tx','topic') AND old.rm_at IS NULL AND old.purged IS NULL;
    INSERT INTO chat_log_fts (rowid, text, rt)
      SELECT new.c, new.text, new.rt
      WHERE new.text IS NOT NULL AND new.k IN ('msg','tx','topic') AND new.rm_at IS NULL AND new.purged IS NULL; END`],
];
// every table this module owns (keep-staging-tables keeps them all; padrekey binds all but pad_chat_cfg to the room)
const TABLES = Object.freeze(["chatlog_rooms", "chat_log", "chatlog_hidden", "chatlog_tx_hidden", "chatlog_private_ever", "chatlog_hidden_held",
  "chatlog_hidden_names", "pad_chat_cfg", "chatlog_open", "chatlog_reports", "chatlog_holds", "chatlog_views", "chatlog_exports", "chatlog_meta",
  "chatlog_erase_wait"]);

// ── state ──
let ATTACHED = false;                      // the archive tables are in the attached schema "chatlog"
const RK = new Map();                      // room id -> rk
const HID = new Map();                     // hidden hash -> {src, since, tok: Map(reason -> ms)}
const TXH = new Map();                     // !transcripts off hash -> {src, since (the last hide - an un-hide must be newer)}
let LOADED = false;                        // the hidden set is in memory (until then every key counts as hidden)
// owner change: hashes waiting in a pending "resolve" / "legacy" batch (never held twice - Pepe's lists come every few seconds),
// and the hashes held as "legacy" (once per run, like hubhidden's) or whose resolve / legacy batch an operator rejected ("keep left
// out" - review 2 fix-up: loaded again at every start, so a rejection lasts)
const HELD_RL = new Set();
const RL_SKIP = new Set();
let ARCHIVE_ERR = null;                    // CL2 fix-up: why the archive tables can't be used (a wrong CHATLOG_DB) - writes fail
const TX_LRU = new Map();                  // "room\ttx id" -> 1 (recently archived transcripts)
const PADCFG = new Map();                  // pad id -> pad_chat_cfg row
let PRIVATE = new Set(PRIVATE_ARGS);
let CURSOR_HW = 0;
let CFG = null;                            // the switches (null until loaded)
const FTS = { on: false, hw: 0, checkedAt: 0, drift: null, repairing: false, partial: false, lastRepair: null, error: null };
const STATS = { written: 0, batches: 0, failures: 0, consecutive: 0, lastError: null, lastErrorAt: 0, lastLogAt: 0, lastOkAt: 0, dupesSkipped: 0 };
let fault = null;                          // tests: throw inside the archive transaction

const archiveSql = (sql) => (ATTACHED ? sql.replace(/^(\s*CREATE (?:UNIQUE INDEX|INDEX|TABLE|VIRTUAL TABLE|TRIGGER) IF NOT EXISTS )([A-Za-z_]+)/, "$1chatlog.$2") : sql);
const dropTrigger = (name) => `DROP TRIGGER IF EXISTS ${ATTACHED ? "chatlog." : ""}${name}`;

/** sha256("pepe-hidden:" + lower(trim(key)))[:20] - quotes.hiddenHash / hubhidden.hash; Pepe's hidden_h. */
const hash = (key) => crypto.createHash("sha256").update("pepe-hidden:" + String(key == null ? "" : key).trim().toLowerCase(), "utf8").digest("hex").slice(0, 20);

// ── setup ──
/**
 * Train 3 review fix-up: is myapp.db's chat_log an archive that never held a line? Nothing counted (chatlog_rooms), the archive
 * never switched on (chatlog_meta 'cfg' READ HERE - never init()'s in-memory switches: a tool calls attach() without them) and no
 * row. Any doubt - an unreadable cfg, a failed read - answers no (the tables stay where they are).
 */
async function mainArchiveEmpty() {
  try {
    const counted = Number((await getQuery(`SELECT COALESCE(SUM("rows"), 0) AS n FROM main.chatlog_rooms`))[0].n) || 0;
    if (counted !== 0) return false;
    const m = (await getQuery("SELECT value FROM main.chatlog_meta WHERE key = 'cfg'"))[0];
    if (m && m.value != null) {
      const raw = JSON.parse(m.value);                                     // unreadable: throws -> not empty
      if (raw != null && (typeof raw !== "object" || raw.started_at || raw.archive_at || bool(raw.archive))) return false;
    }
    if (CFG && (CFG.started_at || CFG.archive)) return false;              // (init's copy: never less than the row says)
    return (await getQuery("SELECT 1 FROM main.chat_log LIMIT 1")).length === 0;
  } catch (e) { return false; }
}
/** Detach chatlog again (a move that didn't happen); a file this call created (still empty) goes with it. */
async function detachArchive(file, existed) {
  await runQuery("DETACH DATABASE chatlog").catch(() => {});
  ATTACHED = false;
  if (!existed) { try { if (fs.statSync(file).size === 0) fs.unlinkSync(file); } catch (e) { /* not there */ } }
}
// SQLite's answers to an ATTACH of a file it can't use (a missing directory, permissions, not a database)
const OPEN_FAIL = /^SQLITE_(CANTOPEN|NOTADB|PERM|READONLY|IOERR|CORRUPT|AUTH)/;

/** CHATLOG_DB set: ATTACH it as "chatlog" on the shared connection (WAL, synchronous NORMAL). Idempotent. Tools call it too.
 *  Throws (code "archive_db") rather than start a NEW, empty archive file while myapp.db's counters say the archive holds
 *  lines (a mistyped or moved CHATLOG_DB): nothing is created, nothing is attached. Train 3 review fix-up: a file that can't be
 *  opened at all is code "archive_db" too (init() then keeps the live chat going and the admin page says why) - fix-up 2: and one
 *  SQLite can open but not WRITE (read-only file or volume), asked before anything leaves myapp.db.
 *  opts.move (init() only): an EMPTY archive that a boot without CHATLOG_DB left in myapp.db moves to CHATLOG_DB. A tool never
 *  moves anything (remove-stray-pad's dry run writes nothing): it uses the archive where the running site has it. */
async function attach(opts = {}) {
  if (!ARCHIVE_DB) return false;
  const move = !!(opts && opts.move);
  const dbs = await getQuery("PRAGMA database_list");
  if (dbs.some((d) => d.name === "chatlog")) { ATTACHED = true; return true; }
  const file = path.resolve(ARCHIVE_DB);
  // CL2 fix-up: what the archive counted so far (chatlog_rooms lives in myapp.db) - a file without those lines is the wrong one
  let counted = 0;
  try { counted = Number((await getQuery(`SELECT COALESCE(SUM("rows"), 0) AS n FROM main.chatlog_rooms`))[0].n) || 0; } catch (e) { counted = 0; }
  // never split an archive: chat_log already in myapp.db means CHATLOG_DB was set after the archive started there. Train 3 review:
  // unless it never held a line - every boot without CHATLOG_DB creates the (empty) archive tables in myapp.db, so the first deploy
  // would otherwise decide decision 25 by itself: an EMPTY chat_log (no row, nothing counted, the archive never switched on) and its
  // index / triggers are dropped from myapp.db and the archive starts in CHATLOG_DB. Fix-up: CHATLOG_DB is ATTACHED first (a path
  // that can't be opened leaves myapp.db's tables alone), and the emptiness is asked again INSIDE the transaction that drops them
  const inMain = (await getQuery("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'chat_log'")).length > 0;
  const keep = (why) => { console.error("[chatlog] CHATLOG_DB is set but chat_log already lives in myapp.db - " + why); return false; };
  if (inMain && !move) return keep("this run uses it there (the site moves an archive that never held a line at its next start)");
  if (inMain && !(await mainArchiveEmpty())) return keep("keeping it there (move it by hand first)");
  const wrong = (why) => Object.assign(new Error(`CHATLOG_DB (${file}) ${why}, but the archive has counted ${counted} line(s) - ` +
                                                 "fix the path and restart; nothing is archived meanwhile"), { code: "archive_db" });
  if (counted > 0 && !fs.existsSync(file)) throw wrong("doesn't exist");
  const existed = fs.existsSync(file);
  try {
    await runQuery("ATTACH DATABASE ? AS chatlog", [file]);
  } catch (e) {
    if (!OPEN_FAIL.test(String(e && e.code)) && !/unable to open|not a database/i.test(String(e && e.message))) throw e;
    throw Object.assign(new Error(`CHATLOG_DB (${file}) can't be opened (${e.code || e.message}) - fix the path or its permissions and ` +
                                  "restart; nothing is archived meanwhile" + (inMain ? " (the empty archive tables stay in myapp.db)" : "")),
                        { code: "archive_db" });
  }
  // (counted > 0 never reaches the move below: mainArchiveEmpty() needs nothing counted. Asked before anything is written to the
  // file - a wrong CHATLOG_DB is left exactly as it was)
  if (counted > 0) {
    let has = false;
    try { has = (await getQuery("SELECT 1 FROM chatlog.chat_log LIMIT 1")).length > 0; } catch (e) { has = false; }
    if (!has) { await detachArchive(file, true); throw wrong("holds no archived line"); }
  }
  // Train 3 review fix-up 2: the file must take WRITES before anything leaves myapp.db. SQLite opens a file it may not write (a
  // read-only file, a read-only or remounted volume, an immutable file - root included) READ-ONLY without a word, so the ATTACH
  // above succeeds; before this the empty tables were dropped, then journal_mode / the archive DDL threw SQLITE_READONLY - init()
  // rejected on every call (not archive_db) and bridge.js closed every pad's live chat. A write that changes nothing (user_version
  // set to itself; journal_mode alone passes on a file that is already WAL) answers here: code archive_db, myapp.db untouched.
  // (The write is init()'s only - a tool's bare attach() writes nothing, as before.)
  try {
    await getQuery("PRAGMA chatlog.journal_mode = WAL");
    await runQuery("PRAGMA chatlog.synchronous = NORMAL").catch(() => {});
    if (move) {
      const uv = Math.floor(Number(((await getQuery("PRAGMA chatlog.user_version"))[0] || {}).user_version)) || 0;
      await runQuery(`PRAGMA chatlog.user_version = ${uv}`);
    }
  } catch (e) {
    await detachArchive(file, existed);
    throw Object.assign(new Error(`CHATLOG_DB (${file}) can't be written (${e.code || e.message}) - fix its permissions, its volume (read-only?) or ` +
                                  "its free space and restart; nothing is archived meanwhile" + (inMain ? " (the empty archive tables stay in myapp.db)" : "")),
                        { code: "archive_db" });
  }
  if (inMain) {
    let moved = false;
    try {
      moved = await tx(async () => {
        // Train 3 review fix-up 2: two starts racing (pm2 / a manual start / the updater) - the other one moved the tables after this
        // one's first look: the archive lives in CHATLOG_DB now, so this start stays ATTACHED (detaching made init() create a NEW
        // chat_log in myapp.db - a split archive that the next start then kept, ignoring the lines in CHATLOG_DB)
        if (!(await getQuery("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'chat_log'")).length) return "gone";
        if (!(await mainArchiveEmpty())) return false;                     // a line landed meanwhile (another process): stays
        for (const [name] of TRIGGERS) await runQuery(`DROP TRIGGER IF EXISTS main.${name}`);
        await runQuery("DROP TABLE IF EXISTS main.chat_log_fts");
        await runQuery("DROP TABLE IF EXISTS main.chat_log");
        return true;
      });
    } catch (e) {
      await detachArchive(file, existed);
      return keep(`the move failed (${e.message}) - keeping it there`);
    }
    if (!moved) { await detachArchive(file, existed); return keep("it holds a line now - keeping it there (move it by hand first)"); }
    console.log(moved === "gone" ? "[chatlog] CHATLOG_DB is set: another start of the site moved the empty archive tables already - the archive lives in " + file
                                 : "[chatlog] CHATLOG_DB is set: the empty archive tables left myapp.db - the archive lives in " + file);
  }
  ATTACHED = true;
  return true;
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      for (const s of MAIN_DDL) await runQuery(s);
      // the hidden set FIRST: it never depends on the archive's tables (a wrong CHATLOG_DB must not leave it unloaded)
      await loadHidden();
      for (const r of await getQuery("SELECT rk, room_id FROM chatlog_rooms")) RK.set(r.room_id, r.rk);
      await loadPadCfg();
      CURSOR_HW = Math.max(CURSOR_HW, Number(await metaGet("cursor_hw")) || 0);
      FTS.hw = Number(await metaGet("fts_hw")) || 0;
      await loadCfg();
      try {
        await attach({ move: true });
        for (const s of ARCHIVE_DDL) await runQuery(archiveSql(s));
        ARCHIVE_ERR = null;
      } catch (e) {
        if (!e || e.code !== "archive_db") throw e;
        ARCHIVE_ERR = e.message;                                 // CL2 fix-up: the live chat, the hidden set and the switches go on
        STATS.lastError = e.message.slice(0, 200); STATS.lastErrorAt = now();
        console.error("[chatlog] " + e.message);
        return;
      }
      await setupFts();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── the hidden set: rows <-> memory ──
/** A chatlog_hidden row's reasons. A row from before the reasons were kept (scopes NULL): pepe = Pepe's list (unknown kind:
 *  both), web = the website's ON, forget | delete | staff = themselves. */
function reasonsOf(r) {
  const out = new Map();
  let o = null;
  try { o = r.scopes ? JSON.parse(r.scopes) : null; } catch (e) { o = null; }
  if (o && typeof o === "object" && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o)) if (REASON_RE.test(k)) out.set(k, Math.floor(Number(v)) || Number(r.since) || 0);
  }
  if (!out.size) {
    const at = Number(r.since) || 0;
    if (PROTECTED.has(r.src)) out.set(r.src, at);
    else if (r.src === "web") out.set("web", at);
    else { out.set("list_b", at); out.set("list_i", at); }
  }
  return out;
}
/** At boot (init): the set into memory - chatlog_hidden gets its scopes column first (a table from before the CL2 fix-up). */
async function loadHidden() {
  const cols = (await getQuery("SELECT name FROM pragma_table_info('chatlog_hidden')")).map((c) => c.name);
  if (!cols.includes("scopes")) await runQuery("ALTER TABLE chatlog_hidden ADD COLUMN scopes TEXT");
  const h = new Map(), t = new Map();
  for (const r of await getQuery("SELECT h, since, src, scopes FROM chatlog_hidden")) h.set(r.h, { src: r.src, since: Number(r.since) || 0, tok: reasonsOf(r) });
  for (const r of await getQuery("SELECT h, since, src FROM chatlog_tx_hidden")) t.set(r.h, { src: r.src, since: Number(r.since) || 0 });
  HID.clear(); TXH.clear();
  for (const [k, v] of h) HID.set(k, v);
  for (const [k, v] of t) TXH.set(k, v);
  HELD_RL.clear();
  for (const r of await getQuery("SELECT hs FROM chatlog_hidden_held WHERE state = 'pending' AND kind IN ('resolve', 'legacy')")) {
    for (const x of heldList(r.hs)) HELD_RL.add(x.h);
  }
  // owner-change fix-up (review 2, LOW): an operator's "keep left out" (a REJECTED resolve / legacy batch) lasts across restarts -
  // those hashes are never held again as a new batch on every deploy (Pepe's own privacy.shown still un-hides them)
  for (const r of await getQuery("SELECT hs FROM chatlog_hidden_held WHERE state = 'rejected' AND kind IN ('resolve', 'legacy')")) {
    for (const x of heldList(r.hs)) if (x && x.h) RL_SKIP.add(x.h);
  }
  LOADED = true;
}
/** A held batch's entries -> [{h, rm?, at?}] (a batch held before the reasons were kept is bare hashes). */
function heldList(hs) {
  let list = [];
  try { list = JSON.parse(hs); } catch (e) { list = []; }
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const o = typeof x === "string" ? { h: x } : x && typeof x === "object" ? x : {};
    const h = cleanHash(o.h);
    if (h) out.push(Object.assign({}, o, { h }));
  }
  return out;
}

/** The FTS5 index: a self-test on a temp. probe first; the triggers exist only when it passes (else search's LIKE fallback,
 *  CL9, and archive writes never break). The triggers are re-made every start (one transaction), so a fix always takes. */
async function setupFts() {
  try {
    await runQuery("DROP TABLE IF EXISTS temp.chatlog_fts_probe");
    await runQuery("CREATE VIRTUAL TABLE temp.chatlog_fts_probe USING fts5(text, tokenize = 'unicode61 remove_diacritics 2')");
    await runQuery("INSERT INTO temp.chatlog_fts_probe (text) VALUES ('probe café')");
    const r = await getQuery("SELECT rowid FROM temp.chatlog_fts_probe WHERE chatlog_fts_probe MATCH ? LIMIT 1", ['"cafe"']);
    await runQuery("DROP TABLE IF EXISTS temp.chatlog_fts_probe");
    if (r.length !== 1) throw new Error("the FTS5 self-test found nothing");
    await runQuery(archiveSql(FTS_DDL));
  } catch (e) {
    console.error("[chatlog] FTS5 unavailable - no index triggers (search falls back to LIKE):", e.message);
    for (const [name] of TRIGGERS) await runQuery(dropTrigger(name)).catch(() => {});
    FTS.on = false;
    FTS.error = e.message;
    return false;
  }
  await tx(async () => {
    for (const [name, sql] of TRIGGERS) {
      await runQuery(dropTrigger(name));
      await runQuery(archiveSql(sql));
    }
  });
  FTS.on = true;
  FTS.error = null;
  return true;
}

async function metaGet(key) {
  const r = (await getQuery("SELECT value FROM chatlog_meta WHERE key = ?", [key]))[0];
  return r ? r.value : null;
}
async function metaSet(key, value) {
  await runQuery("INSERT INTO chatlog_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
}

// ── the switches ──
const SWITCHES = Object.freeze({ notice: false, archive: false, history: false, search: false, downloads: false, purge: true });
const bool = (v) => v === true || v === 1 || v === "1" || v === "true" || v === "on";
const ms = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : null);
/** A clean config from anything (bad values -> the defaults). */
function cleanCfg(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [k, def] of Object.entries(SWITCHES)) out[k] = c[k] == null ? def : bool(c[k]);
  out.notice_at = out.notice ? ms(c.notice_at) : null;
  out.started_at = ms(c.started_at);                       // the archive's first switch-on ever (the policy's "from" date)
  out.archive_at = out.archive ? ms(c.archive_at) : null;
  out.tripped = c.tripped && typeof c.tripped === "object" && ms(c.tripped.at) ? { at: ms(c.tripped.at), why: String(c.tripped.why || "").slice(0, 200) } : null;
  out.changed_at = ms(c.changed_at);
  out.by = c.by ? String(c.by).slice(0, 40) : null;
  if (out.notice && !out.notice_at) out.notice_at = now();
  if (out.archive && !out.notice) out.archive = false;     // never writing without the notice (and the policy text)
  return out;
}
async function loadCfg() {
  let raw = null;
  try { raw = JSON.parse((await metaGet("cfg")) || "null"); } catch (e) { raw = null; }
  CFG = cleanCfg(raw);
  return CFG;
}
/** The switches (defaults until init has loaded them). */
function cfg() { return CFG ? { ...CFG } : cleanCfg(null); }
const on = (name) => !!(CFG && CFG[name]);
/** When chatlog.archive may go on (ms), or null while the notice is off. */
function archiveOpensAt(c = CFG) { return c && c.notice && c.notice_at ? c.notice_at + NOTICE_DAYS * DAY : null; }

/** Does the archive hold any line? (An unreadable archive counts as yes: the policy text never goes down on a guess.) */
async function archiveHasRows() {
  if (ARCHIVE_ERR) return true;
  try { return (await getQuery("SELECT 1 FROM chat_log LIMIT 1")).length > 0; } catch (e) { return true; }
}

class Refuse extends Error { constructor(status, message, code, extra) { super(message); this.status = status; this.code = code; this.refuse = true; Object.assign(this, extra || {}); } }

/** Flip one switch (admin). -> {cfg, seed?} | throws Refuse. Every change is a room_events row ("chatlog.switch"). */
async function setSwitch(name, value, actor = null) {
  await init();
  if (!Object.prototype.hasOwnProperty.call(SWITCHES, name)) throw new Refuse(400, "No such switch.", "bad_switch");
  const want = bool(value);
  const cur = cfg();
  if (cur[name] === want) return { cfg: cur, unchanged: true };
  const t = now();
  const next = { ...cur, [name]: want, changed_at: t, by: actor ? String(actor).slice(0, 40) : null };
  if (name === "notice") {
    if (!want && cur.archive) throw new Refuse(409, "Turn the archive off first - the policy text must stay up while it writes.", "archive_on");
    // CL2 fix-up: nor while archived lines exist (a trip or a manual archive off leaves them): the policy must keep stating them
    if (!want && (await archiveHasRows())) throw new Refuse(409, "The archive still holds lines - the policy text stays up while it does.", "archive_rows");
    next.notice_at = want ? t : null;
  }
  if (name === "archive" && want) {
    const opens = archiveOpensAt(cur);
    if (!opens) throw new Refuse(409, "Turn the notice on first: the archive starts 7 days after it.", "notice_off");
    if (t < opens) throw new Refuse(409, `The archive can't start until ${new Date(opens).toISOString().slice(0, 16).replace("T", " ")} UTC (7 days after the notice).`, "notice_wait", { opens_at: opens });
    if (ARCHIVE_ERR) throw new Refuse(409, ARCHIVE_ERR, "archive_db");
    next.archive_at = t;
    next.started_at = cur.started_at || t;
    next.tripped = null;
    STATS.consecutive = 0;                                 // CL2 fix-up: a fresh start - the next failure isn't the 21st in a row
  }
  if (name === "archive" && !want) next.archive_at = null;
  // CL9 fix-up: search opens its results in the history - it answers only while scrollback is on (chatlogsearch.js), so it isn't
  // turned on before it (runbook step 7 before step 8)
  if (name === "search" && want && !cur.history) throw new Refuse(409, "Turn chatlog.history (scrollback) on first: a search result opens its line in the history.", "history_off");
  const clean = cleanCfg(next);
  await metaSet("cfg", JSON.stringify(clean));
  CFG = clean;
  try { await require("./rooms").event(null, "chatlog.switch", actor || null, `${name} ${want ? "on" : "off"}`); } catch (e) { /* audit is best effort */ }
  const out = { cfg: cfg() };
  if (name === "archive" && want && SEED_AT_SWITCH_ON) {
    try { out.seed = await seed(); } catch (e) { console.error("[chatlog] seed:", e.message); out.seed = { error: e.message }; }
  }
  return out;
}

// ── commands with private arguments ──
const CMD_RE = /^![a-z0-9_]{1,40}$/;
/** Is this chat line a private_args command ("!verify 1234", "/msg bob ...")? First token, case-insensitive. */
function isPrivateCmd(text) {
  const t = String(text == null ? "" : text).replace(/^\s+/, "");
  if (t[0] !== "!" && t[0] !== "/") return false;
  const first = "!" + t.slice(1).split(/\s/)[0].toLowerCase();
  return PRIVATE.has(first);
}
/** Pepe's published help can only ADD commands to the list (entries with private_args: true, their commands + aliases). */
async function privateFromHelp() {
  try {
    const cur = await require("./help").current();
    const add = [];
    for (const e of (cur && cur.data && cur.data.entries) || []) {
      if (!e || e.private_args !== true) continue;
      for (const c of [...(e.commands || []), ...(e.aliases || [])]) if (CMD_RE.test(String(c))) add.push(String(c));
    }
    if (add.length) PRIVATE = new Set([...PRIVATE_ARGS, ...PRIVATE, ...add]);
    return add.length;
  } catch (e) { return 0; }
}

// ── the cursor ──
/** At boot: the highest c the archive or the high-water mark knows (bridge.js takes the max with bridge_feed's). */
async function bootCursor() {
  try { await init(); } catch (e) { console.error("[chatlog] init:", e.message); }
  let a = 0, b = 0;
  try { a = Number((await getQuery("SELECT MAX(c) AS c FROM chat_log"))[0].c) || 0; } catch (e) { a = 0; }
  try { b = Number(((await getQuery("SELECT value FROM chatlog_meta WHERE key = 'cursor_hw'"))[0] || {}).value) || 0; } catch (e) { b = 0; }
  CURSOR_HW = Math.max(CURSOR_HW, b);
  return Math.max(a, b);
}
/** Once per sync that wrote items (archive on or off): the cursor's high-water mark, so a c is never handed out twice. */
async function noteCursor(c) {
  const n = Math.floor(Number(c) || 0);
  if (!(n > CURSOR_HW)) return false;
  await runQuery(`INSERT INTO chatlog_meta (key, value) VALUES ('cursor_hw', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
                  WHERE CAST(chatlog_meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)`, [String(n)]);
  CURSOR_HW = n;
  return true;
}

// ── duplicates (asked BEFORE bridge.js hands out a cursor) ──
/** -> {eids: Set (already archived; only inside the boot window), tx: Set("room\ttx id" already archived)}.
 *  eids: event ids that missed SEEN_EVENTS; tx: [[roomId, txId]] of the batch's transcripts. Never throws. */
async function dupes({ eids = [], tx: pairs = [] } = {}) {
  const out = { eids: new Set(), tx: new Set() };
  try {
    if (!ready) return out;
    await ready;
    const ids = [...new Set(eids.filter((x) => typeof x === "string" && x))];
    if (ids.length && now() - BOOT_AT < BOOT_EID_MS) {
      for (let i = 0; i < ids.length; i += 400) {
        const part = ids.slice(i, i + 400);
        for (const r of await getQuery(`SELECT eid FROM chat_log WHERE eid IN (${part.map(() => "?").join(",")})`, part)) out.eids.add(r.eid);
      }
    }
    const byRk = new Map();
    for (const [roomId, txId] of pairs) {
      if (!txId) continue;
      const key = roomId + "\t" + txId;
      if (TX_LRU.has(key)) { out.tx.add(key); continue; }
      const rk = RK.get(roomId);
      if (!rk) continue;
      if (!byRk.has(rk)) byRk.set(rk, { roomId, ids: [] });
      byRk.get(rk).ids.push(txId);
    }
    for (const [rk, { roomId, ids: t }] of byRk) {
      for (const r of await getQuery(`SELECT tx FROM chat_log WHERE rk = ? AND tx IN (${t.map(() => "?").join(",")})`, [rk, ...t])) out.tx.add(roomId + "\t" + r.tx);
    }
    STATS.dupesSkipped += out.eids.size + out.tx.size;
  } catch (e) { console.error("[chatlog] duplicate check:", e.message); }
  return out;
}

// ── the archive write ──
const AUD = { public: "p", members: "m", approved: "a" };
/** One feed item -> its chat_log row (the mapper the seed uses too). */
function rowOf({ it, eid = null, mid = null }, rk, aud) {
  const u = it.u && typeof it.u === "object" ? it.u : null;
  // owner change: an incognito person's line Pepe sent anonymised keeps its speaker's hash (never a login) as "h:<hash>" - the
  // shape a purged line's who has, so the per-login tool, legal holds, Remove my line and the left-out rule (once that hash is
  // left out: !bridge hide, forget-me) all reach it; the row itself says "someone" (d.u {anon})
  const ah = u && u.anon && typeof it.ah === "string" && HASH_RE.test(it.ah) ? it.ah : null;
  const who = ah ? "h:" + ah : u && !u.anon && u.login ? String(u.login).trim().toLowerCase().slice(0, 70) : null;
  const text = INDEXABLE_KINDS.includes(it.k) && typeof it.text === "string" ? it.text : null;
  const d = {};
  for (const [k, v] of Object.entries(it)) if (!ITEM_SKIP.has(k) && v !== undefined) d[k] = v;
  if (u) { const du = {}; for (const f of U_KEEP) if (u[f] !== undefined) du[f] = u[f]; d.u = du; }
  if (ah && Array.isArray(it.ahs)) {
    const more = [...new Set(it.ahs.filter((x) => typeof x === "string" && HASH_RE.test(x) && x !== ah))];
    if (more.length) d.ahs = more;
  }
  return { c: Number(it.c), rk, ts: Math.floor(Number(it.ts) || now()), k: String(it.k), who, text, rt: "r" + rk, aud, d: JSON.stringify(d),
           mid: typeof mid === "string" && mid ? mid.slice(0, 160) : null,
           tx: it.k === "tx" && typeof it.id === "string" && it.id ? it.id : null,
           eid: typeof eid === "string" && eid ? eid.slice(0, 128) : null };
}
const byteLen = (s) => (s == null ? 0 : Buffer.byteLength(String(s), "utf8"));
const indexable = (r) => r.text != null && INDEXABLE_KINDS.includes(r.k) && r.rm_at == null && r.purged == null;

/** Inside a transaction: the room's rk, creating its chatlog_rooms row (the pad / owner seen now; the first owner's
 *  exemption starts at 0 - CL3's reconcile moves owner_since when the owner changes). */
async function rkInTx(roomId, created) {
  let rk = RK.get(roomId) || created.get(roomId);
  if (rk) return rk;
  let reg = null;
  try { reg = require("./rooms").getCached(roomId); } catch (e) { reg = null; }
  await runQuery(`INSERT INTO chatlog_rooms (room_id, pad_id, owner_id, owner_since, created) VALUES (?, ?, ?, 0, ?)
                  ON CONFLICT(room_id) DO NOTHING`, [roomId, reg ? reg.id : null, reg && reg.owner ? reg.owner.userId : null, now()]);
  rk = (await getQuery("SELECT rk FROM chatlog_rooms WHERE room_id = ?", [roomId]))[0].rk;
  created.set(roomId, rk);
  return rk;
}
const INSERT = "INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d, mid, tx, eid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
/** Inside a transaction: write rows (already mapped) and their rooms' counters. */
async function writeRows(rows) {
  const per = new Map();
  for (const r of rows) {
    await runQuery(INSERT, [r.c, r.rk, r.ts, r.k, r.who, r.text, r.rt, r.aud, r.d, r.mid, r.tx, r.eid]);
    let a = per.get(r.rk);
    if (!a) { a = { n: 0, idx: 0, bytes: 0, minC: r.c, minTs: r.ts }; per.set(r.rk, a); }
    a.n++;
    if (indexable(r)) a.idx++;
    a.bytes += byteLen(r.text) + byteLen(r.d) + byteLen(r.who) + byteLen(r.mid) + byteLen(r.tx) + byteLen(r.eid) + 48;
    if (r.c < a.minC) { a.minC = r.c; a.minTs = r.ts; }
  }
  for (const [rk, a] of per) {
    await runQuery(`UPDATE chatlog_rooms SET "rows" = "rows" + ?, idx_rows = idx_rows + ?, bytes = bytes + ?,
                    first_ts = CASE WHEN first_c IS NULL OR first_c > ? THEN ? ELSE first_ts END,
                    first_c = CASE WHEN first_c IS NULL OR first_c > ? THEN ? ELSE first_c END WHERE rk = ?`,
                   [a.n, a.idx, a.bytes, a.minC, a.minTs, a.minC, a.minC, rk]);
  }
}

/**
 * bridge.ingest / liveNotice: archive this batch ([{roomId, it (with c), eid, mid}]) while chatlog.archive is on - rooms with
 * the 💎 bridge perk only. ONE transaction; NEVER throws (a failure is counted; TRIP_AFTER in a row trip the switch).
 * -> {written} | {written: 0, off | error}
 */
async function archiveBatch(entries) {
  if (!Array.isArray(entries) || !entries.length) return { written: 0 };
  if (!CFG) { try { await init(); } catch (e) { return failed(e); } }
  if (!on("archive")) return { written: 0, off: true };
  let rows = [];
  const created = new Map();
  try {
    await init();
    if (ARCHIVE_ERR) throw Object.assign(new Error("archive_db"), { code: "archive_db" });   // CL2 fix-up: a wrong CHATLOG_DB
    const P = require("./premium");
    await P.init();
    const PA = require("./padaccess");
    await PA.init();
    const take = entries.filter((e) => e && e.it && Number(e.it.c) > 0 && e.roomId && (!PERK_ROOMS_ONLY || P.bridgeAllowed(e.roomId)) &&
                                       !(e.it.k === "msg" && isPrivateCmd(e.it.text)));
    if (!take.length) return { written: 0 };
    let dupes = 0;
    await tx(async () => {
      if (fault) fault();
      rows = [];
      // CL3: the item's own aud (stamped by bridge.js when the line was said) - else the pad's level now
      const audOf = (e) => (["p", "m", "a"].includes(e.it.aud) ? e.it.aud : AUD[PA.levelOf(e.roomId)] || "m");
      for (const e of take) rows.push(rowOf(e, await rkInTx(e.roomId, created), audOf(e)));
      // the seed (switch-on) can copy a line from bridge_feed between its live write and this archive write: same c, SAME line
      // (room, time, kind, speaker) - skipped. A c already taken by a DIFFERENT line is a reused cursor: a bug, so the batch fails
      // and is counted (CL2 fix-up: never skipped silently - the plain-INSERT rule)
      const have = new Map();
      for (let i = 0; i < rows.length; i += 400) {
        const part = rows.slice(i, i + 400).map((r) => r.c);
        for (const x of await getQuery(`SELECT c, rk, ts, k, who FROM chat_log WHERE c IN (${part.map(() => "?").join(",")})`, part)) have.set(Number(x.c), x);
      }
      if (have.size) {
        for (const r of rows) {
          const x = have.get(r.c);
          if (x && !(Number(x.rk) === r.rk && Number(x.ts) === r.ts && x.k === r.k && (x.who || null) === (r.who || null))) {
            throw Object.assign(new Error("a feed cursor already archived for a different line (cursor reuse)"), { code: "cursor_reuse" });
          }
        }
        rows = rows.filter((r) => !have.has(r.c));
        dupes = have.size;
      }
      await writeRows(rows);
    });
    STATS.dupesSkipped += dupes;
  } catch (e) { return failed(e); }
  for (const [id, rk] of created) RK.set(id, rk);
  const rkRoom = new Map([...RK].map(([id, rk]) => [rk, id]));
  for (const r of rows) {
    if (!r.tx) continue;
    TX_LRU.set(rkRoom.get(r.rk) + "\t" + r.tx, 1);
    if (TX_LRU.size > TX_LRU_MAX) TX_LRU.delete(TX_LRU.keys().next().value);
  }
  STATS.written += rows.length; STATS.batches++; STATS.consecutive = 0; STATS.lastOkAt = now();
  return { written: rows.length };
}
function failed(e) {
  STATS.failures++; STATS.consecutive++;
  STATS.lastError = String((e && (e.code || e.message)) || "error").slice(0, 120);
  STATS.lastErrorAt = now();
  // the message of a SQLite error names the constraint, never a value; nothing of the line is logged
  if (now() - STATS.lastLogAt > 60e3) {
    STATS.lastLogAt = now();
    console.error(`[chatlog] archive write failed (${STATS.consecutive} in a row, ${STATS.failures} in all): ${STATS.lastError}`);
  }
  if (STATS.consecutive >= TRIP_AFTER && on("archive")) trip(`${STATS.consecutive} archive writes failed in a row (last: ${STATS.lastError})`);
  return { written: 0, error: true };
}
function trip(why) {
  const next = cleanCfg({ ...CFG, archive: false, archive_at: null, tripped: { at: now(), why }, changed_at: now(), by: "system" });
  CFG = next;
  console.error("[chatlog] chatlog.archive TRIPPED OFF:", why);
  metaSet("cfg", JSON.stringify(next)).catch((e) => console.error("[chatlog] trip save:", e.message));
  require("./rooms").event(null, "chatlog.switch", "system", "archive off (tripped)").catch(() => {});
}

/** The once-only seed at the archive's first switch-on: what bridge_feed holds now (<= 200 per room) of perk rooms, mapped
 *  like new lines, private_args commands left out, rows already archived skipped - and only lines said since the notice went on
 *  (CL2 fix-up: decision 1 rests on "the seeded lines were said during the notice week"; a quiet room's last 200 can be months
 *  older). -> {rows, rooms} | {skipped} */
async function seed() {
  await init();
  if (ARCHIVE_ERR) return { skipped: "archive_db" };
  if (await metaGet("seed_done")) return { skipped: "done" };
  if (!on("archive")) return { skipped: "off" };
  const since = Number(cfg().notice_at) || 0;
  if (!(since > 0)) return { skipped: "no_notice" };
  const has = (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bridge_feed'")).length > 0;
  const P = require("./premium");
  await P.init();
  const PA = require("./padaccess");
  await PA.init();
  const src = has ? await getQuery("SELECT c, room_id, ts, data FROM bridge_feed ORDER BY c") : [];
  const entries = [];
  for (const r of src) {
    if (PERK_ROOMS_ONLY && !P.bridgeAllowed(r.room_id)) continue;
    let it;
    try { it = JSON.parse(r.data); } catch (e) { continue; }
    if (!it || typeof it !== "object" || !it.k) continue;
    it.c = Number(r.c);
    if (!(Number(it.ts) > 0)) it.ts = Number(r.ts) || now();
    if (!(Number(it.ts) >= since)) continue;                // said before the notice: never archived
    if (it.k === "msg" && isPrivateCmd(it.text)) continue;
    entries.push({ roomId: r.room_id, it });
  }
  const created = new Map();
  let rows = [];
  await tx(async () => {
    const have = new Set();
    for (let i = 0; i < entries.length; i += 400) {
      const part = entries.slice(i, i + 400).map((e) => e.it.c);
      for (const x of await getQuery(`SELECT c FROM chat_log WHERE c IN (${part.map(() => "?").join(",")})`, part)) have.add(x.c);
    }
    rows = [];
    const txSeen = new Set();
    for (const e of entries) {
      if (have.has(e.it.c)) continue;
      const rk = await rkInTx(e.roomId, created);
      const row = rowOf(e, rk, ["p", "m", "a"].includes(e.it.aud) ? e.it.aud : AUD[PA.levelOf(e.roomId)] || "m");   // CL3: the line's own aud
      if (row.tx) {
        const key = rk + "\t" + row.tx;
        if (txSeen.has(key) || (await getQuery("SELECT 1 FROM chat_log WHERE rk = ? AND tx = ?", [rk, row.tx])).length) continue;
        txSeen.add(key);
      }
      rows.push(row);
    }
    await writeRows(rows);
    await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('seed_done', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                   [JSON.stringify({ at: now(), rows: rows.length, rooms: new Set(rows.map((r) => r.rk)).size })]);
  });
  for (const [id, rk] of created) RK.set(id, rk);
  console.log(`[chatlog] seeded ${rows.length} line(s) from the live feed`);
  return { rows: rows.length, rooms: new Set(rows.map((r) => r.rk)).size };
}

// ── the sticky hidden set ──
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}
const cleanHash = (h) => (typeof h === "string" && HASH_RE.test(h) ? h : null);
function cleanList(list) {
  if (!Array.isArray(list)) return null;
  const out = new Set();
  for (const x of list) {
    const h = cleanHash(x);
    if (h) out.add(h);
    if (out.size >= LIST_MAX) break;
  }
  return out;
}
/** An event / report time in ms - never later than now (a fast clock elsewhere can't make a stale un-hide look newer than the
 *  website's own hide); none or unreadable = now. */
function whenOf(v) {
  const n = now();
  const t = typeof v === "number" ? v : Date.parse(String(v == null ? "" : v));
  return Number.isFinite(t) && t > 0 ? Math.min(Math.floor(t), n) : n;
}
/** A PCP privacy event -> {type: hidden|shown, h, scope, at} | null. Wire: {type: "privacy.hidden" | "privacy.shown", ts, data: {h, scope}}. */
function cleanEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  const type = ev.type === "privacy.hidden" ? "hidden" : ev.type === "privacy.shown" ? "shown" : null;
  const d = ev.data && typeof ev.data === "object" ? ev.data : {};
  const h = cleanHash(d.h);
  if (!type || !h) return null;
  const scope = SCOPES.has(d.scope) ? d.scope : null;
  if (type === "shown" && !scope) return null;            // an un-hide must say what it un-hides (fail closed)
  return { type, h, scope: scope || "bridge", at: whenOf(ev.ts) };
}

// CL2 fix-up: the reasons a hash is hidden (the header) and the ops that change them, in order:
//   {h, add: reason, at, bump, typed}   a hide (bump: an explicit one moves the reason's time up; typed: Pepe said the kind)
//   {h, rm: [reasons], at}              an un-hide: removes only those reasons, only if they are no newer than `at`
//   {h, list: true, at}                 hidden_h listed it: list_b + list_i, unless a reason Pepe speaks for is already there
// !transcripts off has one reason per hash: {h, add: true, src, at, bump} | {h, rm: true, at}.
const rankOf = (tok) => {
  if (!tok || !tok.size) return 0;
  for (const k of tok.keys()) if (OUT_REASONS.has(k)) return 2;
  return 1;
};
const hasPepeReason = (tok) => { for (const k of tok.keys()) if (PEPE_REASONS.has(k)) return true; return false; };
function stepMain(tok, op) {
  if (op.list) {
    if (hasPepeReason(tok)) return;
    if (!tok.has("list_b")) tok.set("list_b", op.at);
    if (!tok.has("list_i")) tok.set("list_i", op.at);
    return;
  }
  if (op.add) {
    const cur = tok.get(op.add);
    if (cur == null) tok.set(op.add, op.at);
    else if (op.bump && op.at > cur) tok.set(op.add, op.at);
    if (op.typed) {
      // hidden_h showed this very hide before its event arrived: the event says what it was
      for (const k of ["list_b", "list_i"]) { const s = tok.get(k); if (s != null && s >= op.at - LIST_RACE_MS) tok.delete(k); }
      // Pepe confirmed a website ON: his incognito reason carries it from now on
      if (op.add === "incognito") { const w = tok.get("web"); if (w != null && w <= op.at) tok.delete("web"); }
    }
    return;
  }
  // (op.force: CL6 fix-up - staff undoing their own "Hide every line": the one protected reason it names, nothing else)
  if (op.rm) for (const k of op.rm) { const s = tok.get(k); if (s != null && s <= op.at && (!PROTECTED.has(k) || op.force === k)) tok.delete(k); }
}
function stepTx(rec, op) {
  if (op.add) {
    if (!rec) return { src: op.src, since: op.at };
    return { src: PROTECTED.has(op.src) && !PROTECTED.has(rec.src) ? op.src : rec.src, since: op.bump && op.at > rec.since ? op.at : rec.since };
  }
  if (op.rm && rec && !PROTECTED.has(rec.src) && rec.since <= op.at) return null;
  return rec;
}
/** The row's src (a summary; the reasons are the truth): forget | delete | staff once one of them is there (the first kept),
 *  pepe for a reason Pepe speaks for, else web. */
function srcOf(tok, prev) {
  if (prev && PROTECTED.has(prev) && tok.has(prev)) return prev;
  for (const k of ["delete", "forget", "staff"]) if (tok.has(k)) return k;
  return hasPepeReason(tok) ? "pepe" : "web";
}
const sameTok = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
const scopesJson = (tok) => JSON.stringify(Object.fromEntries([...tok].sort((x, y) => (x[0] < y[0] ? -1 : 1))));
const tooMany = (n, size) => n > HOLD_N || (n >= 2 && n > HOLD_PCT * size);
/** privacy.shown {scope} -> its ops: the reasons that scope clears; an incognito un-hide also clears the of:<h> reasons it
 *  explains (a linked account's earlier web lines, hidden with its login). */
function shownOps(h, scope, at) {
  const ops = [{ h, rm: SHOWN_CLEARS[scope], at }];
  if (scope === "incognito") {
    const of = "of:" + h;
    // (`of`: this op only follows the login h's un-hide - the held rule counts the two as ONE person)
    for (const [k, r] of HID) if (r.tok.has(of)) ops.push({ h: k, rm: [of], at, of: h });
  }
  return ops;
}
/** Train 3 review fix-up: how many PEOPLE a batch weakens - the weakened hashes, less each linked account's key (u:<userId>) that
 *  weakens only through its of:<h> reason while its login h weakens in the same batch (one linked person = 2 hashes: without this a
 *  member's own !incognito off was held for an operator whenever the set had fewer than ~20 hashes). */
function weakPeople(weak, ops) {
  const own = new Set(), follows = new Map();
  for (const o of ops) {
    if (!o.rm) continue;
    if (o.of) { if (!follows.has(o.h)) follows.set(o.h, []); follows.get(o.h).push(o.of); } else own.add(o.h);
  }
  let n = 0;
  for (const h of weak) if (own.has(h) || !(follows.get(h) || []).some((x) => weak.has(x))) n++;
  return n;
}

/**
 * Inside serial(): apply ops (main) and txOps (!transcripts off) - simulated first, so the held rule sees what the batch would
 * do: a batch that would WEAKEN too many hashes (un-hide them, or move them from left out to anonymised) keeps its hides and
 * holds its un-hides for an operator. One transaction (plus `also`, inside it). -> {added, removed, weakened, held}
 */
async function applyOps(ops, txOps, { hold = true, also = null, holdKind = "shown" } = {}) {
  const t = now();
  const out = { added: 0, removed: 0, weakened: 0, held: 0 };
  const simMain = (useRm) => {
    const m = new Map();
    for (const op of ops) {
      if (op.rm && !useRm) continue;
      let tok = m.get(op.h);
      if (!tok) {
        const r = HID.get(op.h);
        if (op.list && r && hasPepeReason(r.tok)) continue;      // every sync re-lists everyone: no copy for them
        tok = new Map(r ? r.tok : []);
        m.set(op.h, tok);
      }
      stepMain(tok, op);
    }
    return m;
  };
  const simTx = (useRm) => {
    const m = new Map();
    for (const op of txOps) {
      if (op.rm && !useRm) continue;
      if (!m.has(op.h) && op.add && !op.bump && TXH.has(op.h)) continue;
      m.set(op.h, stepTx(m.has(op.h) ? m.get(op.h) : TXH.get(op.h) || null, op));
    }
    return m;
  };
  let main = simMain(true), txm = simTx(true);
  const held = [];
  if (hold) {
    const weak = weakPeople(new Set([...main].filter(([h, tok]) => rankOf(HID.has(h) ? HID.get(h).tok : null) > rankOf(tok)).map(([h]) => h)), ops);
    if (tooMany(weak, HID.size)) { held.push([holdKind, ops.filter((o) => o.rm).map((o) => ({ h: o.h, rm: o.rm, at: o.at }))]); main = simMain(false); }
    const weakTx = [...txm].filter(([h, r]) => TXH.has(h) && !r).length;
    if (tooMany(weakTx, TXH.size)) { held.push(["shown_tx", txOps.filter((o) => o.rm).map((o) => ({ h: o.h, at: o.at }))]); txm = simTx(false); }
  }
  const writes = [], dels = [], txWrites = [], txDels = [];
  const ch = { added: [], addedTx: [], removed: [], removedTx: [], kinds: [] };
  for (const [h, tok] of main) {
    const old = HID.get(h) || null;
    if (rankOf(old ? old.tok : null) > rankOf(tok)) out.weakened++;
    if (!tok.size) { if (old) { dels.push(h); ch.removed.push(h); } continue; }
    if (old && sameTok(old.tok, tok)) continue;
    writes.push({ h, old, rec: { src: srcOf(tok, old && old.src), since: old ? old.since : t, tok } });
  }
  for (const [h, r] of txm) {
    const old = TXH.get(h) || null;
    if (!r) { if (old) { txDels.push(h); ch.removedTx.push(h); out.weakened++; } continue; }
    if (old && old.src === r.src && old.since === r.since) continue;
    txWrites.push({ h, old, rec: r });
  }
  if (!writes.length && !dels.length && !txWrites.length && !txDels.length && !held.length && !also) return out;
  await tx(async () => {
    for (const w of writes) {
      if (!w.old) {          // a row memory doesn't know (written by hand / another process): its reasons are kept too
        const db = (await getQuery("SELECT since, src, scopes FROM chatlog_hidden WHERE h = ?", [w.h]))[0];
        if (db) {
          for (const [k, v] of reasonsOf(db)) if (!w.rec.tok.has(k) || w.rec.tok.get(k) < v) w.rec.tok.set(k, v);
          w.rec.src = srcOf(w.rec.tok, db.src);
          w.rec.since = Number(db.since) || w.rec.since;
        }
      }
      await runQuery(`INSERT INTO chatlog_hidden (h, since, src, scopes) VALUES (?, ?, ?, ?)
                      ON CONFLICT(h) DO UPDATE SET src = excluded.src, scopes = excluded.scopes`, [w.h, w.rec.since, w.rec.src, scopesJson(w.rec.tok)]);
    }
    // (a row whose last reason a forced op removed - staff's own hide - goes too; Pepe's never removes forget / delete / staff)
    for (const h of dels) {
      const forced = ops.some((o) => o.h === h && o.force);
      await runQuery(forced ? "DELETE FROM chatlog_hidden WHERE h = ? AND src NOT IN ('forget','delete')"
                            : "DELETE FROM chatlog_hidden WHERE h = ? AND src NOT IN ('forget','delete','staff')", [h]);
    }
    for (const w of txWrites) {
      if (!w.old) {
        const db = (await getQuery("SELECT since, src FROM chatlog_tx_hidden WHERE h = ?", [w.h]))[0];
        if (db) w.rec = { src: PROTECTED.has(db.src) ? db.src : w.rec.src, since: Math.max(Number(db.since) || 0, w.rec.since) };
      }
      await runQuery(`INSERT INTO chatlog_tx_hidden (h, since, src) VALUES (?, ?, ?)
                      ON CONFLICT(h) DO UPDATE SET since = excluded.since, src = excluded.src`, [w.h, w.rec.since, w.rec.src]);
    }
    for (const h of txDels) await runQuery("DELETE FROM chatlog_tx_hidden WHERE h = ? AND src NOT IN ('forget','delete','staff')", [h]);
    for (const w of [...writes, ...txWrites]) {
      if (!w.old) await runQuery("INSERT INTO chatlog_private_ever (h, first_at) VALUES (?, ?) ON CONFLICT(h) DO NOTHING", [w.h, t]);
    }
    for (const [kind, list] of held) if (list.length) await runQuery("INSERT INTO chatlog_hidden_held (kind, hs, at, state) VALUES (?, ?, ?, 'pending')", [kind, JSON.stringify(list), t]);
    if (also) await also();
  });
  // owner-change fix-up (review 2): each touched hash's state BEFORE this change (its kind, !transcripts off) - the readers tell
  // from it which lines' look moved (chatlogview.lookMove: a line that stays "someone" is never drawn again)
  ch.prev = new Map();
  for (const h of [...writes.map((w) => w.h), ...dels, ...txWrites.map((w) => w.h), ...txDels]) {
    if (!ch.prev.has(h)) ch.prev.set(h, { kind: hiddenKind(h), tx: TXH.has(h) });
  }
  for (const w of writes) {
    HID.set(w.h, w.rec);
    if (!w.old) ch.added.push(w.h); else if (rankOf(w.old.tok) !== rankOf(w.rec.tok)) ch.kinds.push(w.h);
  }
  for (const h of dels) HID.delete(h);
  for (const w of txWrites) { TXH.set(w.h, w.rec); if (!w.old) ch.addedTx.push(w.h); }
  for (const h of txDels) TXH.delete(h);
  for (const [kind, list] of held) if (kind === "resolve" || kind === "legacy") for (const o of list) HELD_RL.add(o.h);
  out.added = ch.added.length + ch.addedTx.length;
  out.removed = ch.removed.length + ch.removedTx.length;
  out.held = held.reduce((n, [, l]) => n + new Set(l.map((o) => o.h)).size, 0);
  if (out.held) console.log(`[chatlog] held ${out.held} un-hide(s) for an operator (/admin/bridge)`);
  hiddenChanged(ch);
  return out;
}
// CL3: who listens to hidden-set changes (bridge.js drops a newly hidden person's lines from open pages; chatlogview.js
// re-derives the names it redacts). Called after the in-memory set changed; a listener never breaks the change. CL2 fix-up:
// `kinds` = hashes still hidden whose kind changed (left out <-> anonymised).
const HIDDEN_LISTENERS = new Set();
function onHidden(fn) { if (typeof fn === "function") HIDDEN_LISTENERS.add(fn); }
function hiddenChanged(ch) {
  if (!ch.kinds) ch.kinds = [];
  if (!ch.added.length && !ch.addedTx.length && !ch.removed.length && !ch.removedTx.length && !ch.kinds.length) return;
  for (const fn of HIDDEN_LISTENERS) { try { fn(ch); } catch (e) { console.error("[chatlog] hidden listener:", e.message); } }
}

/**
 * A bridge sync's privacy state: `list` = Pepe's hidden_h (ADD-only), `txList` = his tx_hidden_h (!transcripts off, ADD-only),
 * `events` = its privacy.hidden / privacy.shown events (in order). A list never un-hides anyone - empty, short or cut. Serialised.
 * -> promise of {added, removed, weakened, held} | {ignored}. bridge.js waits for it only when the sync carried events (so a
 * failed write makes Pepe re-send them: at-least-once).
 */
function noteSync({ list, txList, events, bridge, incog } = {}) {
  const L = cleanList(list), TL = cleanList(txList), LB = cleanList(bridge), LI = cleanList(incog);
  const evs = (Array.isArray(events) ? events : []).map(cleanEvent).filter(Boolean);
  if (!L && !TL && !LB && !LI && !evs.length) return Promise.resolve({ ignored: true });
  // both kinded lists, uncut: Pepe vouches for who is hidden by which kind right now (each is null when that state didn't load)
  const whole = (raw, S) => !!S && Array.isArray(raw) && raw.length <= LIST_MAX;
  const kinded = whole(bridge, LB) && whole(incog, LI);
  return serial(async () => {
    await init();
    const ops = [], txOps = [];
    for (const e of evs) {
      if (e.scope === "tx") txOps.push(e.type === "hidden" ? { h: e.h, add: true, src: "pepe", at: e.at, bump: true } : { h: e.h, rm: true, at: e.at });
      else if (e.type === "hidden") ops.push({ h: e.h, add: e.scope, at: e.at, bump: true, typed: true });
      else ops.push(...shownOps(e.h, e.scope, e.at));
    }
    const t = now();
    // owner change: the kinded lists add their kind's reason (a list's say-so: added when missing, never moves its time) - BEFORE
    // the mixed list, which then adds nothing for a hash they already explain
    if (LB) for (const h of LB) ops.push({ h, add: "bridge", at: t, bump: false });
    if (LI) for (const h of LI) ops.push({ h, add: "incognito", at: t, bump: false });
    if (L) for (const h of L) ops.push({ h, list: true, at: t });
    if (TL) for (const h of TL) txOps.push({ h, add: true, src: "pepe", at: t, bump: false });
    const out = await applyOps(ops, txOps);
    if (kinded) {
      const r = await resolveKinds(L, LB, LI, t);
      out.resolved = r.resolved; out.held += r.held; out.weakened += r.weakened; out.removed += r.removed;
    }
    return out;
  });
}
/**
 * Inside serial(), owner change: Pepe's vouched kinded lists account for the hashes only an older list put here (list_b / list_i:
 * kind unknown). One a list carries loses its unknown reasons (it keeps the kinds the lists just added: bridge stays left out,
 * incognito only becomes "someone" - a weakening, so the held rule applies, as kind "resolve"). One neither kinded list nor his
 * mixed list carries is held for an operator ("legacy", once per run) - nothing un-hides it on its own. A hash already waiting in
 * a resolve / legacy batch is left alone until that batch is decided. -> {resolved, held, weakened, removed}
 */
async function resolveKinds(L, LB, LI, t) {
  const res = [], legacy = [];
  for (const [h, r] of HID) {
    if (!r.tok.has("list_b") && !r.tok.has("list_i")) continue;
    if (HELD_RL.has(h) || RL_SKIP.has(h)) continue;
    if (LB.has(h) || LI.has(h)) res.push({ h, rm: ["list_b", "list_i"], at: t });
    else if (!(L && L.has(h))) legacy.push(h);
  }
  const out = { resolved: 0, held: 0, weakened: 0, removed: 0 };
  if (res.length) {
    const r = await applyOps(res, [], { holdKind: "resolve" });
    out.held += r.held; out.weakened += r.weakened; out.removed += r.removed;
    out.resolved = r.held ? 0 : res.length;          // (held whole, or applied whole)
  }
  if (legacy.length) {
    const list = legacy.map((h) => ({ h, rm: ["list_b", "list_i"], at: t }));
    await tx(() => runQuery("INSERT INTO chatlog_hidden_held (kind, hs, at, state) VALUES ('legacy', ?, ?, 'pending')", [JSON.stringify(list), t]));
    for (const h of legacy) { RL_SKIP.add(h); HELD_RL.add(h); }
    out.held += legacy.length;
    console.log(`[chatlog] held ${legacy.length} hash(es) Pepe no longer lists as hidden (legacy, kind unknown) for an operator (/admin/bridge)`);
  }
  return out;
}
/**
 * Hide chat keys (logins / u:<userId>) at once. src: web (a website Incognito ON) | pepe | forget | delete | staff; scope:
 * "bridge" | "incognito" (which reason a Pepe hide is) | "tx" (!transcripts off). opts: {at: ms (Pepe's report time), assert:
 * true (a list's say-so: added if missing, never moves a reason's time), of: <login> (the account key of a linked account whose
 * login is incognito: reason of:<hash(login)>)}. -> promise of {added, ...}
 */
function hideNow(keys, src = "web", scope = "bridge", opts = {}) {
  const s = SOURCES.has(src) ? src : "web";
  const o = opts && typeof opts === "object" ? opts : {};
  const hs = [...new Set((Array.isArray(keys) ? keys : [keys]).filter((k) => k != null && String(k).trim()).map(hash))];
  if (!hs.length) return Promise.resolve({ added: 0, removed: 0, weakened: 0, held: 0 });
  const at = o.at != null ? whenOf(o.at) : now();
  const assert = !!o.assert;
  return serial(async () => {
    await init();
    if (scope === "tx") return applyOps([], hs.map((h) => ({ h, add: true, src: s, at, bump: !assert })));
    const of = o.of != null && String(o.of).trim() ? "of:" + hash(o.of) : null;
    const reason = of || (s === "pepe" ? (scope === "incognito" ? "incognito" : "bridge") : s);
    return applyOps(hs.map((h) => ({ h, add: reason, at, bump: !assert, typed: s === "pepe" && !assert && !of })), []);
  });
}
/** CL6 fix-up: staff undo their own "Hide every line" (chatlogmod's per-login tool, audited there): only the `staff` reason of
 *  these keys goes - Pepe's reasons, a website Incognito, forget-me and account deletion stay. -> promise of {removed, weakened} */
function unhideStaff(keys) {
  const hs = [...new Set((Array.isArray(keys) ? keys : [keys]).filter((k) => k != null && String(k).trim()).map(hash))];
  if (!hs.length) return Promise.resolve({ added: 0, removed: 0, weakened: 0, held: 0 });
  return serial(async () => {
    await init();
    const at = now();
    return applyOps(hs.map((h) => ({ h, rm: ["staff"], at, force: "staff" })), [], { hold: false });
  });
}
/** An operator's decision on a held batch: approve applies its un-hides now - each still only against reasons no newer than
 *  itself, so a hide that came after the batch was held survives. -> {removed, weakened} | throws Refuse */
function decideHeld(id, approve, actor = null) {
  return serial(async () => {
    await init();
    const r = (await getQuery("SELECT id, kind, hs, at, state FROM chatlog_hidden_held WHERE id = ?", [Math.floor(Number(id)) || 0]))[0];
    if (!r) throw new Refuse(404, "No such held change.", "not_found");
    if (r.state !== "pending") throw new Refuse(409, "Already decided.", "decided");
    let list = [];
    try { list = JSON.parse(r.hs); } catch (e) { list = []; }
    const at0 = Number(r.at) || now();
    const ops = [], txOps = [];
    for (const x of Array.isArray(list) ? list : []) {
      // a batch held before the reasons were kept is bare hashes: an un-hide of all Pepe speaks for, as of when it was held
      const o = typeof x === "string" ? { h: x } : x && typeof x === "object" ? x : {};
      const h = cleanHash(o.h);
      if (!h) continue;
      const at = Number(o.at) > 0 ? Math.min(Math.floor(Number(o.at)), at0) : at0;
      if (r.kind === "shown_tx") { txOps.push({ h, rm: true, at }); continue; }
      const rm = Array.isArray(o.rm) ? o.rm.filter((k) => typeof k === "string" && REASON_RE.test(k) && !PROTECTED.has(k)) : ["bridge", "incognito", "list_b", "list_i", "web"];
      if (rm.length) ops.push({ h, rm, at });
    }
    const mark = () => runQuery("UPDATE chatlog_hidden_held SET state = ? WHERE id = ?", [approve ? "approved" : "rejected", r.id]);
    const res = approve ? await applyOps(ops, txOps, { hold: false, also: mark }) : (await tx(mark), { removed: 0, weakened: 0 });
    // owner change: a decided resolve / legacy batch's hashes may be looked at again - a rejected one not before the next run
    if (r.kind === "resolve" || r.kind === "legacy") {
      for (const o of heldList(r.hs)) { HELD_RL.delete(o.h); if (!approve) RL_SKIP.add(o.h); }
    }
    try { await require("./rooms").event(null, "chatlog.held", actor || null, `${approve ? "approved" : "rejected"} #${r.id} (${list.length})`); } catch (e) { /* audit */ }
    return { removed: res.removed, weakened: res.weakened };
  });
}
// Fail closed: until the set is loaded (init), every key counts as hidden - hiddenReady() says when it is.
const isHiddenHash = (h) => !LOADED || HID.has(h);
const isTxHiddenHash = (h) => !LOADED || TXH.has(h);
const isHiddenKey = (key) => key != null && isHiddenHash(hash(key));
const isTxHiddenKey = (key) => key != null && isTxHiddenHash(hash(key));
const hiddenReady = () => LOADED;
/** CL2 fix-up (the owner's 2026-10-19 decision-9 change reads this): "out" = left out (!bridge hide, forget / delete / staff, or
 *  Pepe listed them without saying why) | "anon" = incognito only (anonymised) | null = not hidden. "out" until loaded. */
const hiddenKind = (h) => { if (!LOADED) return "out"; const r = HID.get(h); return r ? (rankOf(r.tok) === 2 ? "out" : "anon") : null; };
const hiddenReasons = (h) => { const r = HID.get(h); return r ? [...r.tok.keys()].sort() : []; };
/** Owner-change fix-up (review 2, LOW): the site knows of this incognito before Pepe does - a website Incognito ON (`web`) or a
 *  linked account's key (`of:<h>`) - since when (ms), while the hash is "anon" only; else null. A named line Pepe relays after it
 *  (he hasn't anonymised yet) is kept anonymised for good (bridge.js ingest: who "h:<hash>"), so `!incognito off` never puts a
 *  name on words said after the person switched incognito on. */
function siteAnonSince(h) {
  if (!LOADED) return null;
  const r = HID.get(h);
  if (!r || rankOf(r.tok) === 2) return null;
  let t = null;
  for (const [k, at] of r.tok) if ((k === "web" || k.startsWith("of:")) && Number(at) > 0) t = t == null ? Number(at) : Math.min(t, Number(at));
  return t;
}
// owner change - hubhidden.js's reader names (one set at the merge): left out now (fail closed while loading); loading
const isLeftOutHash = (h) => !LOADED || (HID.has(h) && rankOf(HID.get(h).tok) === 2);
const isLeftOutKey = (key) => key != null && isLeftOutHash(hash(key));
const loading = () => !LOADED;
/** A reason -> hubhidden's kind (the header): bridge | incognito | unknown | protected. `tok` = all of the hash's reasons (list_i
 *  is "unknown" beside list_b, "incognito" once the bridge half was shown). */
function kindOfReason(k, tok) {
  if (k === "bridge") return "bridge";
  if (k === "incognito" || k === "web" || k.startsWith("of:")) return "incognito";
  if (k === "list_b") return "unknown";
  if (k === "list_i") return tok && tok.has("list_b") ? "unknown" : "incognito";
  return "protected";                                                 // forget | delete | staff
}
/** hubhidden's kinds of a hash (sorted; [] = not hidden). */
function kindsOf(h) {
  const r = HID.get(h);
  if (!r) return [];
  return [...new Set([...r.tok.keys()].map((k) => kindOfReason(k, r.tok)))].sort();
}
/** The merge map (one set with hubhidden.js): every hash as hubhidden's rows {h, kind, since, src} - src pepe (Pepe said so: an
 *  event, a list, a report) | web (a website ON Pepe hasn't confirmed; a linked account's key) | forget | delete | staff. */
function hubRows() {
  const out = [];
  for (const [h, r] of HID) {
    const by = new Map();
    for (const [k, at] of r.tok) {
      const kind = kindOfReason(k, r.tok);
      const src = kind === "protected" ? k : k === "web" || k.startsWith("of:") ? "web" : "pepe";
      const cur = by.get(kind);
      // one row per kind: the earliest time; Pepe's word beats a website ON, a protected source beats both
      if (!cur) by.set(kind, { h, kind, since: at, src });
      else { cur.since = Math.min(cur.since, at); if (cur.src === "web" && src !== "web") cur.src = src; }
    }
    out.push(...by.values());
  }
  return out;
}
const txHiddenHashes = () => [...TXH.keys()];
// CL3: by hash (chatlogview.js caches each login's hash - the read paths never hash per line per poll)
const hiddenHashes = () => [...HID.keys()];
const hiddenCount = () => {
  let out = 0;
  for (const r of HID.values()) if (rankOf(r.tok) === 2) out++;
  return { hidden: HID.size, tx: TXH.size, out, anon: HID.size - out, ready: LOADED };
};

// ── per-pad settings and windows (CL3 owns the routes; the owner sync needs the effective windows now) ──
async function loadPadCfg() {
  PADCFG.clear();
  for (const r of await getQuery("SELECT * FROM pad_chat_cfg")) PADCFG.set(r.room_id, r);
}
function padCfg(padId) {
  const r = PADCFG.get(String(padId || ""));
  return { window_s: r && r.window_s != null ? Number(r.window_s) : null, search: r && r.search != null ? !!r.search : null,
           downloads: r && r.downloads != null ? !!r.downloads : null, mods_all: r && r.mods_all != null ? !!r.mods_all : null,
           locked: !!(r && r.locked), updated: r ? Number(r.updated) || null : null };
}
/** CL3 (padchat.js): the cached row after a write (null = the row is gone). */
function setPadCfgRow(padId, row) {
  if (row) PADCFG.set(String(padId), row); else PADCFG.delete(String(padId));
}
/** CL3: every pad with a settings row (the admin card). */
const padCfgIds = () => [...PADCFG.keys()];
/** The pad's retention in seconds per class (null = for good) from Pepe's mirrored windows and the pad's CURRENT tier. */
function retentionSecs(padId) {
  const P = require("./premium");
  const R = P.retention();
  const tier = P.padPerks(padId).retention;                   // unlimited | prime | standard
  const pick = (cls) => {
    const v = R[tier === "unlimited" ? cls + "_plus" : tier === "prime" ? cls + "_prime" : cls + "_days"];
    return v == null ? null : Number(v) * 86400;
  };
  return { chat: pick("chat"), tx: pick("rec") };
}
/** min(setting, retention) per class: null = no limit, 0 = off. */
function effectiveWindows(padId) {
  const c = padCfg(padId), r = retentionSecs(padId);
  const eff = (ret) => (c.window_s === 0 ? 0 : c.window_s == null ? ret : ret == null ? c.window_s : Math.min(c.window_s, ret));
  return { chat: eff(r.chat), tx: eff(r.tx) };
}

/**
 * The owner sync's per-room `chatlog` block (POST /api/rooms/owners; Pepe CL4 announces and bounds !log / !search with it):
 * {notice_at, archive, window_s, tx_s, search, wm_search, changed_at, removed, removed_who}. window_s / tx_s: the effective public
 * windows in seconds (null = no limit, 0 = off). removed: [[sec, login_h], ...] - CL6 (chatlogmod.removedFor): the room's newest
 * 500 taken-down chat / mic lines, unix seconds + sha256("pepe-hidden:" + login)[:20]. removed_who: [[login_h, until_sec | null],
 * ...] - CL6 fix-up (chatlogmod.removedWho): people whose lines the site took down as a whole (staff "Hide every line" / forget-me /
 * account deletion: null = every line, any time; a staff "Delete every line": the lines up to until_sec). Added to every Camfrog
 * pad's row.
 * Train 3 review (the site follow-ups Pepe CL4 reads - pepe_chatlog.clean_block):
 *   wm_chat / wm_tx  the room's own forward-only watermarks (ms; chatlog_rooms wm_* with the expiry watermark exp_*, after a
 *                    reconcile when the site already tracks the room - a missed hook never reaches Pepe; 0 for a room it doesn't:
 *                    it has none) - Pepe follows them exactly instead of raising his own to every changed_at;
 *   removed_ok       true = the removed list was read in full (only then may a shorter list replace the one Pepe kept);
 *   changed_at       the pad's own changes only (its settings row, the reconciled inputs, an open request) - a flip of a global
 *                    chatlog switch (notice at launch, purge, history, search, downloads, a trip) is no change to this pad's !log:
 *                    it used to close !log / !search before that moment in every pad-linked room on a Pepe without wm_*.
 * (POST /api/rooms/owners answers chatlog_known: true beside the rooms - roomsweb.js.)
 */
async function forOwnerSync(rows) {
  await init();
  const list = Array.isArray(rows) ? rows : [];
  const wm = new Map();
  for (const r of await getQuery("SELECT room_id, wm_search FROM chatlog_rooms")) wm.set(r.room_id, Number(r.wm_search) || 0);
  const c = cfg();
  let platformOf = () => "camfrog";
  try { platformOf = require("./rooms").platformOf; } catch (e) { /* no registry */ }
  let P = null;
  try { P = require("./premium"); } catch (e) { P = null; }
  // CL3: a pending "Also open earlier history" (open_at = when it takes effect) and when the room's watermarks last moved
  let CV = null;
  try { CV = require("./chatlogview"); await CV.init(); } catch (e) { CV = null; }
  // CL6: the lines the site took down (hidden, removed, purged) - Pepe's !log / !search skip them
  let CLM = null;
  try { CLM = require("./chatlogmod"); } catch (e) { CLM = null; }
  // CL6 fix-up: and the PEOPLE taken down site-wide (staff "Hide every line" / "Delete every line", forget-me, account deletion):
  // [[login hash, until (unix s) | null = every line]] - the same for every room (a consumer that doesn't know it ignores it)
  let rmWho = [];
  try { rmWho = CLM ? await CLM.removedWho() : []; } catch (e) { rmWho = []; }
  for (const row of list) {
    if (!row || !row.id || platformOf(row.id) !== "camfrog") continue;
    const pc = padCfg(row.id), w = effectiveWindows(row.id);
    // Train 3 review: the room's watermarks for Pepe - reconciled first when the site tracks the room (never creating a row for one
    // it doesn't). Can't be read -> not sent (Pepe then falls back to his own, closing at changed_at: fails closed). Fix-up: a room
    // the site doesn't track (no chatlog_rooms row) has no watermarks here to follow - none are sent either (never 0: Pepe follows
    // wm_* exactly when present, and a 0 would throw away the forward-only watermark he raised himself, e.g. on a tier downgrade)
    let wmc = null;
    if (CV) {
      try {
        const id = String(row.id);
        const tracked = wm.has(id);                       // (a chatlog_rooms row: the views' or the archive's)
        const R = tracked ? await CV.reconcileNow(id) : null;
        if (tracked && !R) throw new Error("reconcile failed");
        const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
        wmc = R ? { chat: Math.max(num(R.wm_chat), num(R.exp_chat), num(R.exp && R.exp.chat)), tx: Math.max(num(R.wm_tx), num(R.exp_tx), num(R.exp && R.exp.tx)) }
                : null;
      } catch (e) { wmc = null; }
    }
    const si = CV ? CV.syncInfo(row.id) : { open_at: null, changed_at: null };
    const rm = CLM ? (CLM.removedRead ? await CLM.removedRead(row.id) : { list: await CLM.removedFor(row.id), ok: false }) : { list: [], ok: false };
    row.chatlog = {
      notice_at: c.notice ? c.notice_at : null,
      archive: !!(c.archive && (!PERK_ROOMS_ONLY || !P || P.bridgeAllowed(row.id))),
      window_s: w.chat, tx_s: w.tx,
      search: pc.search !== false,
      wm_search: CV ? Math.max(wm.get(row.id) || 0, si.wm_search || 0) : wm.get(row.id) || 0,
      ...(wmc ? { wm_chat: wmc.chat, wm_tx: wmc.tx } : {}),
      changed_at: Math.max(pc.updated || 0, si.changed_at || 0) || null,
      ...(si.open_at ? { open_at: si.open_at } : {}),
      removed: rm.list,
      ...(rm.ok ? { removed_ok: true } : {}),
      removed_who: rmWho,
    };
  }
  return list;
}

// ── the privacy policy (views/privacy.ejs shows the archive text from the moment chatlog.notice is on) ──
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayText = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
/** null while the notice is off; else the dates and Pepe's retention windows (in words) the policy states. */
async function policy() {
  try { if (!CFG) await init(); } catch (e) { return null; }
  const c = cfg();
  if (!c.notice || !c.notice_at) return null;
  let R = null, gate = false;
  try { R = require("./premium").retention(); } catch (e) { R = null; }
  // CL2 fix-up: which rooms are kept follows premium.bridgeAllowed - EVERY room while the Plus bridge gate is off (its default),
  // only 💎 Plus pads (and house pads) while it is on - so the policy says whichever is true now
  try { gate = !!(PERK_ROOMS_ONLY && require("./premium").config().plus_bridge_gate); } catch (e) { gate = false; }
  const w = (v) => (v == null ? "kept for good" : `${v} days`);
  const ret = R ? { chat_free: w(R.chat_days), rec_free: w(R.rec_days), chat_prime: w(R.chat_prime), rec_prime: w(R.rec_prime),
                    chat_plus: w(R.chat_plus), rec_plus: w(R.rec_plus) } : null;
  const startAt = c.started_at || c.notice_at + NOTICE_DAYS * DAY;
  return { notice_at: c.notice_at, notice_day: dayText(c.notice_at), start_at: startAt, start_day: dayText(startAt), started: !!c.started_at,
           purge: c.purge, ret, gate };
}

// ── the FTS index's health ──
async function roQuery(sql, params) {
  try { return await require("./chatlogdb").read(sql, params); } catch (e) {
    if (e && e.code === "unavailable") return getQuery(sql, params);         // no read connection (tests / tools): the shared one
    throw e;
  }
}
/** The incremental check: indexable rows above the high-water mark vs FTS docsize rows there; equal -> the mark moves up,
 *  else a repair of that range starts (not awaited). -> {ok, lo, hi, rows, indexed} */
async function driftCheck({ full = false } = {}) {
  await init();
  if (!FTS.on) return { off: true };
  const lo = full ? 0 : FTS.hw;
  // counts AND the sums of the ids: a missing row next to a stale entry leaves the counts equal, never the sums. CL2 fix-up: ONE
  // statement - one read snapshot - so a line committed between two separate reads can't look like drift
  const x = (await roQuery(`SELECT m.hi AS hi,
      (SELECT COUNT(*) FROM chat_log WHERE c > ? AND c <= m.hi AND ${INDEXABLE}) AS rn,
      (SELECT COALESCE(SUM(c), 0) FROM chat_log WHERE c > ? AND c <= m.hi AND ${INDEXABLE}) AS rs,
      (SELECT COUNT(*) FROM chat_log_fts_docsize WHERE id > ? AND id <= m.hi) AS dn,
      (SELECT COALESCE(SUM(id), 0) FROM chat_log_fts_docsize WHERE id > ? AND id <= m.hi) AS ds
    FROM (SELECT COALESCE(MAX(c), 0) AS hi FROM chat_log) m`, [lo, lo, lo, lo]))[0];
  const hi = Number(x.hi) || 0;
  const rows = Number(x.rn) || 0, indexed = Number(x.dn) || 0;
  FTS.checkedAt = now();
  const out = { ok: rows === indexed && Number(x.rs) === Number(x.ds), lo, hi, rows, indexed, full };
  if (out.ok) {
    FTS.drift = null;
    if (hi > FTS.hw) { FTS.hw = hi; await metaSet("fts_hw", hi); }
  } else {
    FTS.drift = { lo, hi, rows, indexed, at: now(), full };
    console.error(`[chatlog] FTS drift in (${lo}, ${hi}]: ${rows} indexable row(s), ${indexed} indexed - repairing`);
    repair(lo, hi).catch((e) => console.error("[chatlog] FTS repair:", e.message));
  }
  return out;
}
const yieldNow = () => new Promise((r) => setImmediate(r));
/** Re-index (lo, hi] in batches of REPAIR_BATCH cursor values, each its own transaction: missing rows are added, stale entries
 *  removed with the row's own (unchanged) text; an entry whose text is gone (a purge without the trigger) can't be removed
 *  surgically -> the whole index is re-filled (delete-all + batches). Search reads ftsPartial() meanwhile. CL2 fix-up: each
 *  batch READS inside the transaction that writes it (outside writes wait at dbUtils' gate), so a line committed between two
 *  reads can't look like a stale entry (and set off a needless re-fill). */
async function repair(lo, hi) {
  if (FTS.repairing) return { busy: true };
  FTS.repairing = true; FTS.partial = true;
  const res = { added: 0, removed: 0, full: false };
  try {
    let needFull = false;
    for (let a = lo; a < hi && !needFull; ) {
      const b = Math.min(hi, a + REPAIR_BATCH);
      await tx(async () => {
        const rows = await getQuery("SELECT c, k, text, rt, rm_at, purged FROM chat_log WHERE c > ? AND c <= ?", [a, b]);
        const ids = new Set((await getQuery("SELECT id FROM chat_log_fts_docsize WHERE id > ? AND id <= ?", [a, b])).map((r) => r.id));
        const byC = new Map(rows.map((r) => [r.c, r]));
        const missing = rows.filter((r) => indexable(r) && !ids.has(r.c));
        const extra = [...ids].filter((id) => { const r = byC.get(id); return !r || !indexable(r); });
        if (extra.some((id) => { const r = byC.get(id); return !r || r.text == null; })) { needFull = true; return; }
        for (const id of extra) { const r = byC.get(id); await runQuery("INSERT INTO chat_log_fts (chat_log_fts, rowid, text, rt) VALUES ('delete', ?, ?, ?)", [r.c, r.text, r.rt]); }
        for (const r of missing) await runQuery("INSERT INTO chat_log_fts (rowid, text, rt) VALUES (?, ?, ?)", [r.c, r.text, r.rt]);
        res.added += missing.length; res.removed += extra.length;
      });
      a = b;
      await yieldNow();
    }
    FTS.drift = null;
    if (needFull) { res.full = true; res.added = await refill(); }        // (may set FTS.drift again: its own closing check)
    FTS.lastRepair = { at: now(), ...res };
    const top = Math.min(hi, Number((await getQuery("SELECT MAX(c) AS m FROM chat_log"))[0].m) || 0);   // never above what exists
    if (top > FTS.hw) { FTS.hw = top; await metaSet("fts_hw", top); }
    console.log(`[chatlog] FTS repaired: +${res.added} -${res.removed}${res.full ? " (re-filled)" : ""}`);
    return res;
  } finally {
    FTS.repairing = false; FTS.partial = false;
  }
}
/** delete-all + every indexable row again, in batches (never one transaction). -> rows indexed. CL2 fix-up: `top` is read in the
 *  delete-all's own transaction (lines above it are indexed by the trigger, never twice), and each batch reads inside the
 *  transaction that writes it. A line taken down between batches while its batch hasn't run yet can still leave a stale
 *  entry, so the re-fill ends with a full check (drift = repair again, from the card). */
async function refill() {
  let top = 0;
  await tx(async () => {
    top = Number((await getQuery("SELECT MAX(c) AS m FROM chat_log"))[0].m) || 0;
    await runQuery("INSERT INTO chat_log_fts (chat_log_fts) VALUES ('delete-all')");
  });
  let n = 0;
  for (let a = 0, more = true; a < top && more; ) {
    await tx(async () => {
      const rows = await getQuery(`SELECT c, text, rt FROM chat_log WHERE c > ? AND c <= ? AND ${INDEXABLE} ORDER BY c LIMIT ?`, [a, top, REPAIR_BATCH]);
      if (!rows.length) { more = false; return; }
      for (const r of rows) await runQuery("INSERT INTO chat_log_fts (rowid, text, rt) VALUES (?, ?, ?)", [r.c, r.text, r.rt]);
      n += rows.length;
      a = rows[rows.length - 1].c;
    });
    await yieldNow();
  }
  try {
    const chk = (await getQuery(`SELECT (SELECT COUNT(*) FROM chat_log WHERE ${INDEXABLE}) AS rn, (SELECT COUNT(*) FROM chat_log_fts_docsize) AS dn`))[0];
    if (Number(chk.rn) !== Number(chk.dn)) {
      FTS.drift = { lo: 0, hi: top, rows: Number(chk.rn) || 0, indexed: Number(chk.dn) || 0, at: now(), full: true };
      console.error("[chatlog] FTS re-fill raced a takedown - run Repair again from /admin/bridge");
    }
  } catch (e) { /* the next drift check sees it */ }
  return n;
}
const ftsPartial = () => FTS.partial || !FTS.on;
const ftsState = () => ({ on: FTS.on, hw: FTS.hw, checkedAt: FTS.checkedAt || null, drift: FTS.drift, repairing: FTS.repairing, partial: FTS.partial,
                          lastRepair: FTS.lastRepair, error: FTS.error });

// ── account merge / deletion / export (accountMerge.js, accountdelete.js, accountexport.js) ──
const tableThere = async (t) => (await getQuery("SELECT 1 FROM pragma_table_info(?) LIMIT 1", [t]).catch(() => [])).length > 0;
/** accountMerge (inside the caller's transaction; never creates a table): chat_log.who u:<from> -> u:<to>; a hidden u:<from>
 *  hides u:<to> too (the sticky set). -> {who, hidden} */
async function mergeAccounts(fromId, toId) {
  const out = { who: 0, hidden: 0 };
  if (!fromId || !toId || fromId === toId) return out;
  const a = "u:" + String(fromId).toLowerCase(), b = "u:" + String(toId).toLowerCase();
  const ha = hash(a), hb = hash(b);
  if (await tableThere("chat_log")) {
    const r = await runQuery("UPDATE chat_log SET who = ? WHERE who = ?", [b, a]);
    out.who = (r && r.changes) || 0;
    // the owner's decision-9 change: web lines the loser sent while incognito (Pepe anonymised them: who "h:<hash of u:from>") follow
    // too, so Remove my line, their data export and the per-login tool still find them (a purged line keeps its hash: no author)
    const r2 = await runQuery("UPDATE chat_log SET who = ? WHERE who = ? AND purged IS NULL", ["h:" + hb, "h:" + ha]);
    out.who += (r2 && r2.changes) || 0;
    // CL6 fix-up: the lines the loser hid as a mod / as staff stay theirs (the mod who hid a line may show it again; the muted row
    // names them) - the actor label carries the account id
    for (const role of ["mod", "staff"]) {
      const r3 = await runQuery("UPDATE chat_log SET rm_by = ? WHERE rm_by = ?", [role + ":" + String(toId), role + ":" + String(fromId)]);
      if (r3 && r3.changes) out.rm_by = (out.rm_by || 0) + r3.changes;
    }
  }
  const t = now();
  // (direct SQL, never serial(): this runs inside the caller's transaction, and a queued hidden-set write would wait for it)
  for (const [table, map] of [["chatlog_hidden", HID], ["chatlog_tx_hidden", TXH]]) {
    if (!(await tableThere(table))) continue;
    const main = table === "chatlog_hidden";
    const reasons = main && (await getQuery("SELECT 1 FROM pragma_table_info('chatlog_hidden') WHERE name = 'scopes'")).length > 0;
    const r = (await getQuery(`SELECT * FROM ${table} WHERE h = ?`, [ha]))[0];
    if (!r) continue;
    const cur = (await getQuery(`SELECT * FROM ${table} WHERE h = ?`, [hb]))[0] || null;
    let rec;
    if (main) {
      // CL2 fix-up: the survivor gets every reason the loser was hidden for (each keeps its newest time)
      const tok = cur ? reasonsOf(cur) : new Map();
      for (const [k, v] of reasonsOf(r)) if (!tok.has(k) || tok.get(k) < v) tok.set(k, v);
      rec = { src: srcOf(tok, cur ? cur.src : r.src), since: cur ? Number(cur.since) || t : t, tok };
      if (reasons) {
        await runQuery(`INSERT INTO chatlog_hidden (h, since, src, scopes) VALUES (?, ?, ?, ?) ON CONFLICT(h) DO UPDATE SET src = excluded.src, scopes = excluded.scopes`,
                       [hb, rec.since, rec.src, scopesJson(tok)]);
      } else {
        await runQuery("INSERT INTO chatlog_hidden (h, since, src) VALUES (?, ?, ?) ON CONFLICT(h) DO NOTHING", [hb, t, r.src]);
      }
    } else {
      rec = { src: cur ? (PROTECTED.has(r.src) && !PROTECTED.has(cur.src) ? r.src : cur.src) : r.src,
              since: Math.max(cur ? Number(cur.since) || 0 : 0, Number(r.since) || 0, cur ? 0 : t) };
      await runQuery(`INSERT INTO chatlog_tx_hidden (h, since, src) VALUES (?, ?, ?) ON CONFLICT(h) DO UPDATE SET since = excluded.since, src = excluded.src`,
                     [hb, rec.since, rec.src]);
    }
    if (await tableThere("chatlog_private_ever")) await runQuery("INSERT INTO chatlog_private_ever (h, first_at) VALUES (?, ?) ON CONFLICT(h) DO NOTHING", [hb, t]);
    const was = map.has(hb);
    const prev = new Map([[hb, { kind: hiddenKind(hb), tx: TXH.has(hb) }]]);     // (before the set: the look the lines had)
    map.set(hb, rec);                                          // fail-closed: kept even if the caller's transaction rolls back
    if (!was) hiddenChanged(map === TXH ? { added: [], addedTx: [hb], removed: [], removedTx: [], prev } : { added: [hb], addedTx: [], removed: [], removedTx: [], prev });
    out.hidden++;
  }
  // CL6: a legal hold on the loser's web lines follows them
  if (await tableThere("chatlog_holds")) {
    const h = await runQuery("UPDATE chatlog_holds SET key = ? WHERE key = ? AND NOT EXISTS (SELECT 1 FROM chatlog_holds WHERE key = ?)", ["who:" + b, "who:" + a, "who:" + b]);
    if (h && h.changes) { out.holds = h.changes; try { await require("./chatlogmod").loadHolds(); } catch (e) { /* reloaded at the next start */ } }
  }
  return out;
}
/** accountdelete (inside its transaction): the account's own web lines keep no name ("former member" at read time); its
 *  downloads log goes; its reports and settings changes no longer name it. CL6 fix-up: the staff read audit it WROTE (as staff:
 *  chatlog_views.user_id) is kept for its 2 years like the DM read audits (content_audit_views) - the users row becomes a
 *  pseudonymous tombstone, so the id names nobody - and an audit row that names it as the SUBJECT of a read (chatlog_views.who:
 *  its login / u:<id>) gets opts.pseudo instead. -> counts */
async function deleteAccount(userId, opts = {}) {
  const uid = String(userId), who = "u:" + uid.toLowerCase();
  const o = opts && typeof opts === "object" ? opts : {};
  const out = {};
  const run = async (k, table, sql, params) => {
    if (!(await tableThere(table))) return;
    const r = await runQuery(sql, params);
    if (r && r.changes) out[k] = r.changes;
  };
  if (await tableThere("chat_log")) {
    let n = 0;
    for (const r of await getQuery("SELECT c, d FROM chat_log WHERE who = ?", [who])) {
      let d;
      try { d = JSON.parse(r.d); } catch (e) { d = {}; }
      if (!d || typeof d !== "object") d = {};
      d.u = Object.assign({}, d.u && typeof d.u === "object" ? d.u : {}, { display: "" });
      await runQuery("UPDATE chat_log SET d = ? WHERE c = ?", [JSON.stringify(d), r.c]);
      n++;
    }
    if (n) out.chat_lines_unnamed = n;
  }
  await run("chatlog_exports", "chatlog_exports", "DELETE FROM chatlog_exports WHERE user_id = ?", [uid]);
  if (await tableThere("chatlog_views")) {
    const keys = [who, o.login ? String(o.login).trim().toLowerCase() : null].filter(Boolean);
    const pseudo = o.pseudo ? String(o.pseudo).slice(0, 60) : "deleted";
    let n = 0;
    for (const k of keys) {
      const like = "% " + k.replace(/[\\%_]/g, (m) => "\\" + m) + " %";
      for (const r of await getQuery("SELECT id, who FROM chatlog_views WHERE ' ' || lower(who) || ' ' LIKE ? ESCAPE '\\'", [like])) {
        const next = String(r.who).split(/\s+/).map((x) => (x.toLowerCase() === k ? pseudo : x)).join(" ");
        await runQuery("UPDATE chatlog_views SET who = ? WHERE id = ?", [next, r.id]);
        n++;
      }
    }
    if (n) out.chatlog_views_subject = n;
  }
  await run("chatlog_reports", "chatlog_reports", "UPDATE chatlog_reports SET reporter = NULL WHERE reporter = ?", [uid]);
  await run("pad_chat_cfg", "pad_chat_cfg", "UPDATE pad_chat_cfg SET by_user = NULL WHERE by_user = ?", [uid]);
  await run("chatlog_open", "chatlog_open", "UPDATE chatlog_open SET by_user = NULL WHERE by_user = ?", [uid]);
  return out;
}
const KIND = { msg: "chat", tx: "mic", join: "join", leave: "leave", mic: "mic_grab", unmic: "mic_drop", topic: "topic", live: "live", note: "note" };
/** accountexport: the account's own archived lines (its linked login or u:<id>), oldest first: [{room, ts, kind, text}]. */
async function exportLines(userId, login, max = 50000) {
  if (!(await tableThere("chat_log")) || !(await tableThere("chatlog_rooms"))) return null;
  const keys = [...new Set(["u:" + String(userId).toLowerCase(), login ? String(login).trim().toLowerCase() : null].filter(Boolean))];
  // owner change: the lines they said while incognito (Pepe sent them anonymised: who "h:<hash>") are theirs too - marked so
  const all = [...keys, ...keys.map((k) => "h:" + hash(k))];
  const rows = await getQuery(`SELECT l.c, l.ts, l.k, l.text, l.d, l.who, r.room_id FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk
                               WHERE l.who IN (${all.map(() => "?").join(",")}) AND l.purged IS NULL ORDER BY l.c LIMIT ?`, [...all, max]);
  return rows.map((r) => {
    let kind = KIND[r.k] || r.k;
    if (r.k === "live") { try { if (JSON.parse(r.d).np) kind = "now_playing"; } catch (e) { /* live */ } }
    return { room: r.room_id, ts: new Date(Number(r.ts)).toISOString(), kind, text: r.text == null ? null : r.text,
             ...(String(r.who || "").startsWith("h:") ? { shown_as: "someone" } : {}) };
  });
}

// ── the admin card ("Chat archive" on /admin/bridge) ──
async function adminView() {
  await init();
  const rooms = await getQuery(`SELECT room_id, "rows" AS n, idx_rows, bytes, first_ts FROM chatlog_rooms ORDER BY "rows" DESC LIMIT 200`);
  const tot = (await getQuery(`SELECT COUNT(*) AS rooms, COALESCE(SUM("rows"), 0) AS n, COALESCE(SUM(idx_rows), 0) AS idx, COALESCE(SUM(bytes), 0) AS bytes FROM chatlog_rooms`))[0];
  const held = await getQuery("SELECT id, kind, hs, at FROM chatlog_hidden_held WHERE state = 'pending' ORDER BY id DESC LIMIT 50");
  let title = () => null;
  try { const R = require("./rooms"); title = (id) => { const r = R.getCached(id); return r ? r.title : null; }; } catch (e) { /* no registry */ }
  let seedInfo = null;
  try { seedInfo = JSON.parse((await metaGet("seed_done")) || "null"); } catch (e) { seedInfo = null; }
  const c = cfg();
  // CL3: each pad's chat settings (lockable here), its watermarks, a pending earlier-history opening; the redaction's stop-list
  let pads = [], redact = null;
  try { await require("./chatlogview").init(); pads = require("./padchat").adminRows(); redact = require("./chatlogview").adminInfo(); } catch (e) { pads = []; }
  // CL10: the latest downloads (chatlogexport.js - metadata only: who, which pad, the range, the format, lines, state)
  let downloads = null;
  try { downloads = await require("./chatlogexport").adminRows(); } catch (e) { downloads = null; }
  return {
    pads, redact, downloads,
    cfg: c, opens_at: archiveOpensAt(c), notice_days: NOTICE_DAYS, location: ATTACHED ? "attached chatlog.db" : "myapp.db", seed: seedInfo,
    // CL2 fix-up: why the archive can't write (a wrong CHATLOG_DB), and whether it holds lines (the notice then stays on)
    archive_error: ARCHIVE_ERR, has_rows: await archiveHasRows(),
    stats: { ...STATS }, trip_after: TRIP_AFTER, cursor_hw: CURSOR_HW,
    totals: { rooms: Number(tot.rooms) || 0, rows: Number(tot.n) || 0, indexed: Number(tot.idx) || 0, bytes: Number(tot.bytes) || 0 },
    rooms: rooms.map((r) => ({ room_id: r.room_id, title: title(r.room_id), rows: Number(r.n) || 0, indexed: Number(r.idx_rows) || 0, bytes: Number(r.bytes) || 0,
                               first_ts: Number(r.first_ts) || null })),
    hidden: hiddenCount(),
    // n = the people a held batch would un-hide or move from left out to anonymised (its distinct hashes - never the hashes)
    held: held.map((h) => {
      let n = 0;
      try { n = new Set(JSON.parse(h.hs).map((x) => (typeof x === "string" ? x : x && x.h))).size; } catch (e) { n = 0; }
      return { id: h.id, kind: h.kind, n, at: Number(h.at) };
    }),
    hold_rule: { n: HOLD_N, pct: HOLD_PCT },
    fts: ftsState(),
    private_cmds: [...PRIVATE].sort(),
  };
}

function register(app, { addUser }) {
  const SP = require("./siteperms");
  const guard = require("./middleware/authGuard");
  const json = require("express").json({ limit: "8kb" });
  init().then(() => {
    privateFromHelp();
    if (on("archive") && SEED_AT_SWITCH_ON) metaGet("seed_done").then((d) => (d ? null : seed())).catch((e) => console.error("[chatlog] seed:", e.message));
    const t1 = setTimeout(() => driftCheck().catch((e) => console.error("[chatlog] drift:", e.message)), 60e3);
    if (t1.unref) t1.unref();
    const t = setInterval(() => {
      driftCheck().catch((e) => console.error("[chatlog] drift:", e.message));
      privateFromHelp();
    }, DRIFT_MS);
    if (t.unref) t.unref();
  }).catch((e) => console.error("[chatlog] init:", e.message));
  const can = (req) => SP.can(req.user, "chatlog.admin");
  const post = (req, res) => {
    if (!can(req)) { res.status(403).json({ ok: false, error: "Site admins only." }); return false; }
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) { res.status(403).json({ ok: false, error: "Security check failed - reload the page." }); return false; }
    return true;
  };
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code, ...(e.opens_at ? { opens_at: e.opens_at } : {}) });
    console.error("[chatlog] admin:", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  app.get("/api/admin/chatlog", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    try { res.json({ ok: true, ...(await adminView()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/chatlog/switch", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!post(req, res)) return;
    const b = req.body || {};
    try { res.json({ ok: true, ...(await setSwitch(String(b.name || ""), b.on, req.user.username)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/chatlog/held", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!post(req, res)) return;
    const b = req.body || {};
    if (b.action !== "approve" && b.action !== "reject") return res.status(400).json({ ok: false, error: "approve or reject" });
    try { res.json({ ok: true, ...(await decideHeld(b.id, b.action === "approve", req.user.username)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/chatlog/fts", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!post(req, res)) return;
    const b = req.body || {};
    try {
      if (b.action === "check") return res.json({ ok: true, check: await driftCheck({ full: true }), fts: ftsState() });
      if (b.action === "repair") {
        const hi = Number((await getQuery("SELECT MAX(c) AS m FROM chat_log"))[0].m) || 0;
        repair(0, hi).catch((e) => console.error("[chatlog] FTS repair:", e.message));
        return res.json({ ok: true, started: true, fts: ftsState() });
      }
      res.status(400).json({ ok: false, error: "check or repair" });
    } catch (e) { fail(res, e); }
  });
  // CL7: the retention purge - its report on this card, "run now" / "recount", and the nightly schedule
  require("./chatlogpurge").register(app, { addUser });
}

module.exports = {
  init, attach, register, cfg, on, setSwitch, archiveOpensAt, policy, isPrivateCmd, privateFromHelp, bootCursor, noteCursor, dupes, archiveBatch, rowOf, seed,
  noteSync, hideNow, unhideStaff, decideHeld, isHiddenKey, isTxHiddenKey, hiddenCount, hash, padCfg, loadPadCfg, retentionSecs, effectiveWindows,
  forOwnerSync, driftCheck, repair, ftsPartial, ftsState, mergeAccounts, deleteAccount, exportLines, adminView, Refuse,
  // CL3: the read side lives in chatlogview.js (floors, watermarks, the projection) - these are the spec's names for it
  view: (...a) => require("./chatlogview").view(...a),
  project: (...a) => require("./chatlogview").project(...a),
  reconcile: (...a) => require("./chatlogview").reconcileNow(...a),
  onHidden, isHiddenHash, isTxHiddenHash, hiddenHashes, setPadCfgRow, padCfgIds,
  // CL2 fix-up: the set is loaded (until then every key counts as hidden); a hash's kind (out | anon | null) and its reasons
  hiddenReady, hiddenKind, hiddenReasons, archiveError: () => ARCHIVE_ERR,
  // owner change (decision 9: incognito "someone", !bridge hide left out) - hubhidden.js's reader names; the merge map
  isLeftOutHash, isLeftOutKey, loading, kindsOf, hubRows, txHiddenHashes,
  siteAnonSince,                                     // owner-change fix-up (review 2): named lines after a website ON stay anonymised
  now: () => now(),
  noteRk: (roomId, rk) => { if (roomId && rk) RK.set(roomId, rk); },
  archivePath: () => (ATTACHED ? path.resolve(ARCHIVE_DB) : null),
  TABLES, MAIN_DDL, ARCHIVE_DDL, FTS_DDL, TRIGGERS, PRIVATE_ARGS, SWITCHES, NOTICE_DAYS, SEED_AT_SWITCH_ON, PERK_ROOMS_ONLY, TRIP_AFTER, HOLD_N, HOLD_PCT,
  BOOT_EID_MS, INDEXABLE, REPAIR_BATCH, RT_SHARE, LIST_RACE_MS,
  _stats: STATS, _fts: FTS,
  _setClock: (f) => { clock = f || (() => Date.now()); },
  _setBoot: (t) => { BOOT_AT = t; },
  _setFault: (f) => { fault = f || null; },
  _reset: () => { STATS.consecutive = 0; },
  _restartHidden: () => { RL_SKIP.clear(); return loadHidden(); },     // tests: the set as a fresh start loads it (review 2 fix-up)
};
