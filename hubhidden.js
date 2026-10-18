// hubhidden.js — Pepe's hidden_h set, kept for the chat hub (R-14 / the privacy seam, 1.99acm; the chat design §1.7, §3.7,
// §9.2, seam plan D-5 / D-6).
//
// Every bridge sync carries Pepe's hidden_h: the hashes of the chat logins that are private right now (incognito, bridge
// hide), sha256("pepe-hidden:" + lower(trim(login)))[:20] - quotes.hiddenHash. quotes.js keeps it in memory only; the hub
// needs it durably (its hidden_hashes / private_ever caches, and v1's privacy/changed snapshot) - so, ONLY while the
// hubseam.privacy switch is on (off: nothing is stored, and switching it off empties the table):
//
//   hub_hidden_h(h TEXT PRIMARY KEY, since INTEGER NOT NULL)      the current set; `since` = when v1 first saw the hash
//
// note(list) diffs the new set against the last one and writes only the difference, in one dbUtils.tx; a trigger
// (huboutbox.js, switch hubseam.privacy) turns each insert / delete into a privacy/changed row "hh:<h>". Calls are
// serialised (one write in flight; a newer list waiting behind it replaces any older waiting one), and the bridge sync never
// waits for them. A list that isn't an array (an older Pepe) is ignored; at most 5,000 valid 20-hex values are kept (the
// cap quotes.setHidden uses). Hashes only - never a login.
"use strict";
const crypto = require("crypto");
// (dbUtils is loaded on first use: hash() / loginHash() never open the database - tools/hubseam-vectors.js uses them)
const db = () => require("./dbUtils");

const MAX = 5000;
const HASH_RE = /^[0-9a-f]{20}$/;
const LOGIN_RE = /^[A-Za-z0-9_.$-]{1,40}$/;          // the logins the hub accepts (ASCII; seam plan D-6)

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

let ready = null;
function init() {
  if (!ready) {
    ready = db().runQuery("CREATE TABLE IF NOT EXISTS hub_hidden_h (h TEXT PRIMARY KEY, since INTEGER NOT NULL)")
      .then(() => undefined).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** A Pepe list -> the set we keep (valid hashes, deduped, capped), or null when it isn't a list. */
function clean(list) {
  if (!Array.isArray(list)) return null;
  const out = new Set();
  for (const x of list) {
    if (typeof x === "string" && HASH_RE.test(x)) out.add(x);
    if (out.size >= MAX) break;
  }
  return out;
}

let last = null;                 // the set as stored (null until loaded)
let running = null;              // the write in flight
let waiting = null;              // the newest list behind it
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

async function apply(next) {
  await init();
  const { runQuery, getQuery, tx } = db();
  if (!last) last = new Set((await getQuery("SELECT h FROM hub_hidden_h")).map((r) => r.h));
  if (same(last, next)) return { added: 0, removed: 0 };
  const add = [...next].filter((h) => !last.has(h));
  const del = [...last].filter((h) => !next.has(h));
  const t = now();
  await tx(async () => {
    for (const h of del) await runQuery("DELETE FROM hub_hidden_h WHERE h = ?", [h]);
    for (const h of add) await runQuery("INSERT OR IGNORE INTO hub_hidden_h (h, since) VALUES (?, ?)", [h, t]);
  });
  last = next;
  return { added: add.length, removed: del.length };
}

/**
 * Pepe's hidden_h from a bridge sync. -> a promise of {added, removed} (or {ignored: true}). Never run two at once: a list
 * arriving while one is written waits, and only the newest waiting list is written next. 1.99acm: ignored while the
 * hubseam.privacy switch is off - nothing is stored (turning the switch off empties the table: huboutbox.setSettings); the
 * first sync after it turns on writes the whole set (the triggers emit every hash, the snapshot covers the rest).
 */
function note(list) {
  if (!require("./huboutbox").on("privacy")) { last = null; return Promise.resolve({ ignored: true }); }
  const next = clean(list);
  if (!next) return Promise.resolve({ ignored: true });
  if (running) {
    const p = new Promise((resolve, reject) => {
      if (waiting) waiting.resolve({ superseded: true });
      waiting = { next, resolve, reject };
    });
    return p;
  }
  const run = (n) => {
    running = apply(n).catch((e) => { last = null; throw e; }).finally(() => {
      running = null;
      if (waiting) {
        const w = waiting;
        waiting = null;
        run(w.next).then(w.resolve, w.reject);
      }
    });
    return running;
  };
  return run(next);
}

/** The current set (for the privacy/changed snapshot). */
async function all() {
  await init();
  return db().getQuery("SELECT h, since FROM hub_hidden_h ORDER BY h");
}

module.exports = { init, note, all, hash, loginHash, clean, MAX, HASH_RE, LOGIN_RE,
  _forget: () => { last = null; },                 // the table was emptied (the privacy switch went off): reload on the next write
  _reset: () => { last = null; running = null; waiting = null; },
  _setClock: (f) => { clock = f || (() => Date.now()); } };
