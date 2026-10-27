// frognames.js - 1.99afn: frog names for people who are private on the website ("Soggy Bullfrog", "Neon Tadpole"). The ONE
// generator every surface shares (spec G:/ops/incognito-micstage-design-2026-10-27.md section C, follow-ups FU-3; owner
// answers of 2026-10-27, spec section M).
//
// What a frog name is for: a private person (Pepe's !incognito / !bridge hide, the site's Incognito switch) is never named on
// a page, but two of them in one place must still be told apart. A frog name is a keyed HMAC of who they are, the place and a
// rotation context - it can't be computed from a login without the server's ALIAS_SECRET, can't be linked across places, and
// changes on a schedule. Nothing here ever returns a login, a hash or a key: callers get the name (and a hood colour) only.
//
// The secret: ALIAS_SECRET in the environment, 32 bytes as 64 hex characters (or base64 / base64url of at least 32 bytes) -
// NOT SECRET_KEY, so the two rotate apart. Missing or unreadable: a random key for this process, one loud console.error and a
// red flag on /admin/system (secretState). Names then change at every restart - that fails private, never open.
//
// Two rotation contexts:
//   (a) boards (boardAliases)   room analytics and other public boards: one name per person per room per DAY, the day turning
//                               at 10:00 UTC (boardPeriod; 06:00 EDT / 05:00 EST, the quiet hour). Deterministic - no state,
//                               no nonce: the same person has the same name on every board of that room all day (one map per
//                               page), a different one in another room, a new one tomorrow. People are placed in order of
//                               their HMAC, never by rank; no adjective or noun repeats on a page, so no pair does either.
//   (b) chat sessions (Sessions) a pad's live chat (WP-2 wires it in): one name per person per pad per APPEARANCE. A session
//                               starts at the first veiled sighting and ends at the first of (owner J-8): back after 1 h+ away
//                               (left the room and came back - a shorter absence keeps the name), their level going back to
//                               normal (incognito off / un-hidden), 12 h old AND quiet for 10 minutes, or 24 h. Never during a
//                               mic hold (the caps wait for the release). Incognito <-> hidden keeps the session. A random
//                               16-byte nonce per session makes sessions unlinkable even to someone holding the key; the
//                               row (incog_alias) has no login - only sk = HMAC(key, room, login) finds an open session after a
//                               restart, and sk / nonce are wiped when it ends (the row is deleted 24 h later). A name is not
//                               used again in the same pad for 24 h, no two open sessions in a pad share a word or a hood
//                               (up to 8), a name never equals anyone's login / display name there, and a person seen NAMED in
//                               that pad less than 15 minutes ago gets a session with NO name ("someone") - so switching a
//                               veil on in the room never puts a frog name right after their real one (C.2).
// The deny lists: no role / privacy / feature words, nothing rude, never "kermit"; a few pairs that read badly ("Sneaky
// Peeper") are skipped. After 64 tries (practically never): "Mystery Frog N", the lowest free N.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

// ── the words (spec C.6: 64 x 44 = 2,816 pairs, 2,755 of them <= 20 characters) ──
const ADJ = Object.freeze([
  // pond
  "Soggy", "Mossy", "Murky", "Misty", "Muddy", "Boggy", "Dewy", "Reedy", "Drizzly", "Splashy", "Bubbly", "Drippy", "Foggy", "Rainy", "Swampy", "Marshy",
  // TV
  "Static", "Fuzzy", "Pixel", "Analog", "Primetime", "Grainy", "Glitchy", "Cathode", "Retro", "Rewound", "Widescreen", "Monochrome", "Technicolor",
  "Syndicated", "Unscripted", "Late-Night",
  // mystery and mood
  "Sneaky", "Hooded", "Masked", "Secret", "Quiet", "Cosmic", "Groovy", "Funky", "Jazzy", "Chill", "Dapper", "Snazzy", "Sly", "Mystery", "Velvet",
  "Midnight", "Moonlit", "Twilight", "Lucky", "Sleepy", "Hoppy", "Bouncy", "Speckled", "Emerald", "Jade", "Minty", "Stealthy", "Undercover", "Cloaked",
  "Phantom", "Mellow", "Curious",
]);
const NOUN = Object.freeze([
  "Frog", "Toad", "Bullfrog", "Treefrog", "Glassfrog", "Reedfrog", "Tadpole", "Pollywog", "Froglet", "Toadlet", "Peeper", "Croaker", "Croakster",
  "Ribbiter", "Hopper", "Leaper", "Jumper", "Splasher", "Paddler", "Gulper", "Bubbler", "Newt", "Axolotl", "Salamander", "Mudpuppy", "Spadefoot",
  "Natterjack", "Pondskipper", "Bogtrotter", "Puddlejumper", "Lilyhopper", "Swampling", "Marshling", "Dragonfly", "Firefly", "Mayfly", "Waterbug",
  "Minnow", "Cricket", "Snail", "Turtle", "Heron", "Otter", "Kingfisher",
]);
// never in a name (whole words; the longer ones anywhere inside a word too): roles, privacy, features, rude, the frog
const DENY_WORDS = Object.freeze(["pepe", "admin", "mod", "staff", "owner", "host", "official", "patv", "bot", "camfrog",
  "someone", "anonymous", "incognito", "hidden", "ghost", "on-air", "off-air", "lurker",
  "slimy", "warty", "creepy", "stinky", "ugly", "fat", "dumb", "shady", "toxic", "horny", "kermit"]);
// pairs that read badly together (a "peeper" who sneaks reads as a voyeur; a phantom who croaked)
const DENY_PAIRS = new Set(["Sneaky", "Secret", "Curious", "Midnight", "Late-Night", "Moonlit", "Twilight", "Quiet", "Stealthy", "Undercover",
  "Hooded", "Masked", "Cloaked", "Phantom", "Mystery", "Velvet"].map((a) => (a + " peeper").toLowerCase())
  .concat(["phantom croaker", "phantom croakster", "sleepy croaker", "drippy gulper"]));
const NAME_MAX = 20, TRIES = 64, HOODS = 8;
const FALLBACK = "Mystery Frog";

// ── the key ──
let KEY = null, STATE = null;
/** The 32-byte key: ALIAS_SECRET (64+ hex characters, or base64 / base64url of >= 32 bytes). Missing / unreadable: a random key for
 *  this process, said once and loudly (fails private: names change at a restart). */
function secret() {
  if (KEY) return KEY;
  const raw = String(process.env.ALIAS_SECRET == null ? "" : process.env.ALIAS_SECRET).trim();
  let k = null;
  if (/^(?:[0-9a-fA-F]{2}){32,}$/.test(raw)) k = Buffer.from(raw, "hex");
  else if (/^[A-Za-z0-9+/_-]{43,}={0,2}$/.test(raw)) {
    const b = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length >= 32) k = b;
  }
  if (k) { KEY = k; STATE = "set"; return KEY; }
  STATE = raw ? "invalid" : "missing";
  KEY = crypto.randomBytes(32);
  console.error(`[frognames] ALIAS_SECRET is ${STATE} - using a random key for this process: every frog name changes at the next restart ` +
                "(private, but not stable). Set ALIAS_SECRET (64 hex characters) in .env.");
  return KEY;
}
/** "set" | "missing" | "invalid" (for /admin/system - never the value) */
function secretState() { secret(); return STATE; }

const hmac = (key, ...parts) => {
  const h = crypto.createHmac("sha256", key);
  for (const p of parts) h.update(Buffer.isBuffer(p) ? p : Buffer.from(String(p), "utf8"));
  return h.digest();
};
const u16 = (i) => { const b = Buffer.alloc(2); b.writeUInt16BE(i & 0xffff, 0); return b; };
const CAND = Buffer.from("cand\0", "utf8");
/** letters only, lower case - how two names are compared ("Soggy-Toad" = "soggy toad" = "SoggyToad") */
const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^\p{L}]/gu, "");
const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();

/** Does a name contain a word that may never be in one? Short words (<= 3 letters) as whole words, the rest anywhere. */
function denied(name) {
  const low = String(name).toLowerCase();
  const words = low.split(/[^a-z-]+/).filter(Boolean).flatMap((w) => [w, ...w.split("-")]);
  for (const d of DENY_WORDS) {
    if (d.length <= 3 ? words.includes(d) : low.includes(d)) return true;
  }
  return DENY_PAIRS.has(low);
}
/** The i-th candidate drawn from seed: [adjective, noun, hood preference]. */
function candidate(seed, i) {
  const c = hmac(seed, CAND, u16(i));
  return [ADJ[c.readUInt32BE(0) % ADJ.length], NOUN[c.readUInt32BE(4) % NOUN.length], c[8] % HOODS];
}
/** "Mystery Frog N" with the lowest N not in `taken` (a Set of names). */
function fallbackName(taken) {
  for (let n = 1; ; n++) if (!taken.has(FALLBACK + " " + n)) return FALLBACK + " " + n;
}
/** The first acceptable candidate: {adj, noun, hood, i} or null after TRIES. ok(adj, noun, name) says whether this pad / page takes it. */
function draw(seed, ok) {
  for (let i = 0; i < TRIES; i++) {
    const [adj, noun, hood] = candidate(seed, i);
    const name = adj + " " + noun;
    if (name.length > NAME_MAX || denied(name) || !ok(adj, noun, name)) continue;
    return { adj, noun, hood, i };
  }
  return null;
}

// ── (a) boards: one name per person per room per day ──
const DAY_S = 86400, TURN_S = 10 * 3600;
/** The board day of `t` (ms): it turns at 10:00 UTC. */
const boardPeriod = (t = Date.now()) => Math.floor((Math.floor(t / 1000) - TURN_S) / DAY_S);
/** When the board day of `t` ends (ms) - the next 10:00 UTC. */
const boardPeriodEnds = (t = Date.now()) => ((boardPeriod(t) + 1) * DAY_S + TURN_S) * 1000;
/**
 * The frog names of the private people on one page of a room's boards.
 *   keys        one opaque key per person (an anon row's hash, chatlog.hash(login) of a masked row - the same value for the same
 *               person; never shown). Repeats are one person.
 *   avoidNames  the names the page shows anyway (named rows' logins and display names): no frog name may read like one.
 * -> Map(key -> name). Deterministic for (room, period, the set of keys, avoidNames).
 */
function boardAliases(roomId, period, keys, avoidNames = []) {
  const K = secret();
  const avoid = new Set((avoidNames || []).map(norm).filter(Boolean));
  const people = [...new Set((keys || []).map(String))]
    .map((k) => ({ k, pid: hmac(K, "patv/board-alias/v1\0", String(roomId), "\0", String(period), "\0", k) }))
    .sort((a, b) => Buffer.compare(a.pid, b.pid));
  const usedA = new Set(), usedN = new Set(), names = new Set(), out = new Map();
  for (const p of people) {
    const got = draw(p.pid, (adj, noun, name) => !usedA.has(adj) && !usedN.has(noun) && !avoid.has(norm(name)));
    let name;
    if (got) { usedA.add(got.adj); usedN.add(got.noun); name = got.adj + " " + got.noun; }
    else name = fallbackName(names);
    names.add(name);
    out.set(p.k, name);
  }
  return out;
}

// ── (b) chat sessions: one name per person per pad per appearance ──
const AWAY_MS = 3600e3;                 // owner J-8: back after 1 h+ away = a new session (a shorter absence keeps the name)
const LONG_MS = 12 * 3600e3, QUIET_MS = 10 * 60e3, CAP_MS = 24 * 3600e3;
const NAMED_GAP_MS = 15 * 60e3;         // C.2: seen named this recently in the pad -> the session gets no name
const REUSE_MS = 24 * 3600e3;           // a name isn't used again in the same pad for this long; ended rows are deleted then
const SEEN_WRITE_MS = 60e3;             // last_seen / last_active are written at most this often per session
let clock = () => Date.now();
const OPEN = new Map();                 // room id -> Map(sk -> session)
const RECENT = new Map();               // room id -> [{name, ended}] (ended in the last REUSE_MS - the 24 h no-reuse rule)
const NAMED = new Map();                // "room\tsk" -> when last seen NAMED there (memory only, NAMED_GAP_MS)
const CHAINS = new Map();               // room id -> promise chain (one room's sessions change one at a time)
let ready = null;

function sessInit() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS incog_alias (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, sk TEXT, nonce BLOB,
                      adj TEXT, noun TEXT, name TEXT, hood INTEGER, started INTEGER NOT NULL, last_seen INTEGER, last_active INTEGER,
                      left_at INTEGER, ended INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS incog_alias_room ON incog_alias (room_id, ended)");
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS incog_alias_sk ON incog_alias (sk) WHERE sk IS NOT NULL");
      OPEN.clear(); RECENT.clear();
      const t = clock();
      for (const r of await getQuery("SELECT * FROM incog_alias WHERE ended IS NULL AND sk IS NOT NULL")) {
        const S = rowSession(r);
        roomOpen(S.roomId).set(S.sk, S);
      }
      for (const r of await getQuery("SELECT room_id, name, ended FROM incog_alias WHERE ended IS NOT NULL AND ended > ? AND name IS NOT NULL", [t - REUSE_MS])) {
        recentOf(String(r.room_id)).push({ name: String(r.name), ended: Number(r.ended) });
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
function rowSession(r) {
  return { id: Number(r.id), roomId: String(r.room_id), sk: String(r.sk), adj: r.adj || null, noun: r.noun || null, name: r.name || null,
           hood: r.hood == null ? null : Number(r.hood), started: Number(r.started) || 0, lastSeen: Number(r.last_seen) || 0,
           lastActive: Number(r.last_active) || 0, leftAt: r.left_at == null ? null : Number(r.left_at), holding: false, wroteAt: 0 };
}
const roomOpen = (roomId) => { let m = OPEN.get(roomId); if (!m) { m = new Map(); OPEN.set(roomId, m); } return m; };
const recentOf = (roomId) => { let a = RECENT.get(roomId); if (!a) { a = []; RECENT.set(roomId, a); } return a; };
const skOf = (roomId, login) => hmac(secret(), "patv/alias-row/v1\0", String(roomId), "\0", lower(login)).toString("hex");
function serial(roomId, fn) {
  const prev = CHAINS.get(roomId) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  CHAINS.set(roomId, tail);
  tail.then(() => { if (CHAINS.get(roomId) === tail) CHAINS.delete(roomId); });
  return run;
}
/** Why session S ends at t (null = it goes on). A mic hold keeps it going whatever the clock says. */
function endWhy(S, t) {
  if (S.leftAt != null && t - S.leftAt >= AWAY_MS) return "away";
  if (S.holding) return null;
  if (t - S.started >= CAP_MS) return "cap";
  if (t - S.started >= LONG_MS && t - Math.max(S.lastActive, S.started) >= QUIET_MS) return "long";
  return null;
}
async function endSession(S, t, why) {
  const m = OPEN.get(S.roomId);
  if (m && m.get(S.sk) === S) m.delete(S.sk);
  if (m && !m.size) OPEN.delete(S.roomId);
  S.ended = t; S.why = why;
  if (S.name) recentOf(S.roomId).push({ name: S.name, ended: t });
  await runQuery("UPDATE incog_alias SET sk = NULL, nonce = NULL, ended = ? WHERE id = ?", [t, S.id]);
}
const view = (S) => (S ? { alias: S.name || null, hood: S.name ? S.hood : null, session: S.id } : null);
/** A new session for (room, login): a name (C.3) unless they were seen named there lately (C.2). avoidNames: the pad's roster. */
async function startSession(roomId, login, sk, t, avoidNames) {
  const open = [...(OPEN.get(roomId) || new Map()).values()];
  const recent = recentOf(roomId).filter((x) => t - x.ended < REUSE_MS);
  RECENT.set(roomId, recent);
  const namedAt = NAMED.get(roomId + "\t" + sk);
  const aliasLess = namedAt != null && t - namedAt < NAMED_GAP_MS;
  let adj = null, noun = null, name = null, hood = null;
  const nonce = crypto.randomBytes(16);
  if (!aliasLess) {
    const usedA = new Set(open.map((x) => x.adj).filter(Boolean)), usedN = new Set(open.map((x) => x.noun).filter(Boolean));
    const taken = new Set([...open.map((x) => x.name), ...recent.map((x) => x.name)].filter(Boolean));
    const avoid = new Set((avoidNames || []).map(norm).filter(Boolean));
    const seed = hmac(secret(), "patv/alias/v1\0", String(roomId), "\0", lower(login), "\0", nonce);
    const got = draw(seed, (a, n, nm) => !usedA.has(a) && !usedN.has(n) && !taken.has(nm) && !avoid.has(norm(nm)));
    let pref;
    if (got) { adj = got.adj; noun = got.noun; name = adj + " " + noun; pref = got.hood; }
    else { name = fallbackName(taken); pref = candidate(seed, 0)[2]; }
    const use = new Array(HOODS).fill(0);
    for (const x of open) if (x.hood != null) use[x.hood]++;
    if (!use[pref]) hood = pref;
    else {
      const least = Math.min(...use);
      for (let d = 1; d <= HOODS; d++) { const h = (pref + d) % HOODS; if (use[h] === least) { hood = h; break; } }
    }
  }
  const r = await runQuery(`INSERT INTO incog_alias (room_id, sk, nonce, adj, noun, name, hood, started, last_seen, last_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                           [roomId, sk, nonce, adj, noun, name, hood, t, t, t]);
  const S = { id: Number(r && r.id), roomId, sk, adj, noun, name, hood, started: t, lastSeen: t, lastActive: t, leftAt: null, holding: false, wroteAt: t };
  roomOpen(roomId).set(sk, S);
  return S;
}
/**
 * A veiled sighting of `login` in pad `roomId` (a roster entry, a line, a mic grab, a website relay line). Opens a session if
 * none is open (or the open one has ended), else keeps it. opts: {t, active: a line or a mic event (resets the quiet clock),
 * holding: true / false while a mic hold starts / ends, avoidNames: the pad's roster logins + display names}.
 * -> {alias (null = no name: "someone"), hood, session}
 */
function sight(roomId, login, opts = {}) {
  const room = String(roomId || "");
  if (!room || !lower(login)) return Promise.resolve(null);
  return serial(room, async () => {
    await sessInit();
    const t = opts.t || clock();
    const sk = skOf(room, login);
    let S = (OPEN.get(room) || new Map()).get(sk) || null;
    if (S) {
      const why = endWhy(S, t);
      if (why) { await endSession(S, t, why); S = null; }
    }
    if (!S) S = await startSession(room, login, sk, t, opts.avoidNames);
    S.leftAt = null;
    S.lastSeen = t;
    if (opts.active) S.lastActive = t;
    if (opts.holding === true || opts.holding === false) S.holding = opts.holding;
    if (t - S.wroteAt >= SEEN_WRITE_MS) {
      S.wroteAt = t;
      await runQuery("UPDATE incog_alias SET last_seen = ?, last_active = ?, left_at = NULL WHERE id = ?", [S.lastSeen, S.lastActive, S.id]);
    }
    return view(S);
  });
}
/** `login` was seen NAMED in pad `roomId` (C.2: a veiled sighting less than 15 minutes later opens a session without a name). */
function named(roomId, login, t = clock()) {
  const room = String(roomId || "");
  if (!room || !lower(login)) return;
  NAMED.set(room + "\t" + skOf(room, login), t);
  if (NAMED.size > 50000) NAMED.delete(NAMED.keys().next().value);
}
/** `login` left pad `roomId` (out of its roster): the absence clock starts (back within 1 h keeps the name). */
function left(roomId, login, t = clock()) {
  const room = String(roomId || "");
  return serial(room, async () => {
    await sessInit();
    const S = (OPEN.get(room) || new Map()).get(skOf(room, login));
    if (!S || S.leftAt != null) return false;
    S.leftAt = t; S.holding = false;
    await runQuery("UPDATE incog_alias SET left_at = ? WHERE id = ?", [t, S.id]);
    return true;
  });
}
/** `login`'s level went back to normal (incognito off / un-hidden): their sessions end - in every pad, or just `roomId`. */
async function off(login, roomId = null, t = clock()) {
  await sessInit();
  const rooms = roomId ? [String(roomId)] : [...OPEN.keys()];
  let n = 0;
  for (const room of rooms) {
    n += await serial(room, async () => {
      const S = (OPEN.get(room) || new Map()).get(skOf(room, login));
      if (!S) return 0;
      await endSession(S, t, "off");
      return 1;
    });
  }
  return n;
}
/** The open session's name of `login` in `roomId` right now, without sighting them (null: none, or a session without a name). */
function current(roomId, login) {
  const S = (OPEN.get(String(roomId || "")) || new Map()).get(skOf(String(roomId || ""), login));
  return S ? view(S) : null;
}
/** The names in use in a pad (open sessions, and ended in the last 24 h) - for another context that must not repeat them. */
function namesInUse(roomId, t = clock()) {
  const room = String(roomId || "");
  const out = new Set();
  for (const S of (OPEN.get(room) || new Map()).values()) if (S.name) out.add(S.name);
  for (const x of RECENT.get(room) || []) if (t - x.ended < REUSE_MS) out.add(x.name);
  return out;
}
/** Every minute or so: end what the clock ends (away 1 h+, 12 h + quiet, 24 h) and delete rows ended 24 h ago. -> ended count */
async function sweep(t = clock()) {
  await sessInit();
  let n = 0;
  for (const room of [...OPEN.keys()]) {
    n += await serial(room, async () => {
      let k = 0;
      for (const S of [...(OPEN.get(room) || new Map()).values()]) {
        const why = endWhy(S, t);
        if (why) { await endSession(S, t, why); k++; }
      }
      return k;
    });
  }
  for (const [room, a] of RECENT) {
    const keep = a.filter((x) => t - x.ended < REUSE_MS);
    if (keep.length) RECENT.set(room, keep); else RECENT.delete(room);
  }
  for (const [k, at] of NAMED) if (t - at >= NAMED_GAP_MS) NAMED.delete(k);
  await runQuery("DELETE FROM incog_alias WHERE ended IS NOT NULL AND ended < ?", [t - REUSE_MS]);
  return n;
}

module.exports = {
  ADJ, NOUN, DENY_WORDS, DENY_PAIRS, NAME_MAX, TRIES, HOODS, AWAY_MS, LONG_MS, QUIET_MS, CAP_MS, NAMED_GAP_MS, REUSE_MS,
  secret, secretState, norm, denied, candidate, boardPeriod, boardPeriodEnds, boardAliases,
  sessInit, sight, named, left, off, current, namesInUse, sweep,
  _setClock: (f) => { clock = f || (() => Date.now()); },
  /** tests: forget the key (the next call reads ALIAS_SECRET again) and every session in memory */
  _reset: () => { KEY = null; STATE = null; OPEN.clear(); RECENT.clear(); NAMED.clear(); CHAINS.clear(); ready = null; },
  _open: OPEN,
};
