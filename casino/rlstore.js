// casino/rlstore.js - a roulette wheel's bets, one row per line (O2 / ENGINE-8, release A).
//
// A line used to live only in the wheel's JSON (casino_tables.state: eng.book with full bet objects, plus T.stakes and
// T.escrowed), and every action rewrote that whole JSON - two or three times per bet, ~2 MB per action on a full wheel.
// Now each line is a casino_rl_lines row whose key IS its stake's transactionId (crl:<table>:s<spin>:<uid>:b<opno>, the
// format is unchanged), written in the SAME transaction as the stake (money.charge -> ledger.post joins the caller's
// transaction) and the act key's answer. A row ends in exactly one terminal state:
//   live      charged, on the wheel (the only state PAT is held in: supply.casinoHeld sums these)
//   refunded  <key>:refund credited in the same transaction as the flip (undo, clear, end, copy, restart, audit)
//   settled   its spin landed: the uid's single crl:<table>:s<spin>:<uid>:pay credit (and the House legs) cover it,
//             committed with the flip
// The wheel's eng.book / T.stakes / T.escrowed are in-memory caches of the live rows of its open spin (roulette.js
// load()); the rows are the source of truth.
//
// Release A (rollback safety, decision D10): the site CI rolls a failed deploy back by itself, and the previous build
// reads only the JSON. So the JSON keeps a MIRROR that build can act on (roulette.js mirror()):
//   * nothing drawn yet (idle / betting): eng.book = [], T.stakes = every live line {key, uid, amount}, T.escrowed, and a
//     refund intent {refund: [keys], why: "restart", mirror: 1}. The previous build's recover() runs it at boot: every
//     live line is refunded by its own key (a spin that was never drawn is void - nobody has seen its pocket). This build
//     ignores an intent marked mirror.
//   * drawn (spinning): the full book in the previous build's format, written by the draw and while the spin is in the
//     air, so the previous build lands the spin exactly as this one would (same keys, same set).
// Release B drops the mirror (the JSON is the header only).
//
// reconcile() runs once per wheel per boot, before anything acts: the JSON's book (an older build's lines, or this build's
// frozen mirror) gets its rows, and every live row is checked against the ledger - one whose :refund exists is marked
// refunded (an older build refunded it, or a bug: flagged), one of an earlier spin that landed is settled, one of an
// earlier spin that never landed is refunded. audit() does the same for live rows of wheels that are not open, and
// strays() refunds a stake debit of the open spin that has no row and no refund (an older build's interrupted placement;
// one it refunded - its undo or clear - only gets its record row). Every finding is a flag: logged, kept in `flags`, and
// filed once per boot as an ops alert by roulette.js. audit() runs once per boot whether or not a wheel is open.
// casino_rl_queue (queue() below) holds a queued line changed while its wheel spins - no PAT - so the drawn header is not
// rewritten for one.
"use strict";
const { runQuery, getQuery, tx, inTx } = require("../dbUtils");
const money = require("./money");
const grammar = require("./rlbets");

const STATES = ["live", "refunded", "settled"];
const flags = [];
let ready = false,
  readyP = null;
async function ddl() {
  await runQuery(`CREATE TABLE IF NOT EXISTS casino_rl_lines (
    key TEXT PRIMARY KEY, table_id TEXT NOT NULL, round_no INTEGER NOT NULL, user_id TEXT NOT NULL, opno INTEGER NOT NULL,
    bets TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0),
    state TEXT NOT NULL CHECK (state IN ('live', 'refunded', 'settled')), why TEXT, act_key TEXT, created INTEGER, closed INTEGER)`);
  await runQuery("CREATE INDEX IF NOT EXISTS casino_rl_lines_round ON casino_rl_lines (table_id, round_no, state)");
  await runQuery("CREATE INDEX IF NOT EXISTS casino_rl_lines_live ON casino_rl_lines (table_id) WHERE state = 'live'");
  // (review) maxOpno: a wheel's MAX(opno) is one index seek, not a walk over every row the wheel ever had
  await runQuery("CREATE INDEX IF NOT EXISTS casino_rl_lines_opno ON casino_rl_lines (table_id, opno)");
  // (review) a queued line changed while the wheel spins (queue() below): one row per wheel and player, no PAT
  await runQuery(`CREATE TABLE IF NOT EXISTS casino_rl_queue (
    table_id TEXT NOT NULL, user_id TEXT NOT NULL, round_no INTEGER NOT NULL, rev INTEGER NOT NULL, bets TEXT, profile TEXT,
    act_key TEXT, created INTEGER, PRIMARY KEY (table_id, user_id))`);
}
/** The table and its indexes. Memoized only outside a transaction (inside one the DDL commits or rolls back with it). */
async function ensure() {
  if (ready) return;
  if (inTx()) return ddl();
  if (!readyP)
    readyP = ddl().then(
      () => {
        ready = true;
      },
      (e) => {
        readyP = null;
        throw e;
      },
    );
  return readyP;
}

// ── the bets column: [[token, amount], ...] - kind / nums / odds come back from rlbets.positions ──
const pack = (bets) => JSON.stringify(bets.map((b) => [grammar.token(b), b.amount]));
function bet([token, amount]) {
  const p = grammar.positions[token];
  if (!p || !Number.isSafeInteger(amount) || amount <= 0) throw Error("Unknown roulette position " + token);
  return { kind: p.kind, nums: p.nums, odds: p.odds, amount, token: p.token };
}
const unpack = (text) => JSON.parse(text).map(bet);
/** a row -> the in-memory line ({uid, bets, amount, key}: the shape engine.settle / lossVector and the views read) */
const lineOf = (r) => ({ uid: r.user_id, bets: unpack(r.bets), amount: r.amount, key: r.key });
/** the parts of a stake key: crl:<table>:s<spin>:<uid>:b<opno> */
function parseKey(key) {
  const m = /^crl:([^:]+):s(\d+):(.+):b(\d+)$/.exec(String(key || ""));
  return m ? { table: m[1], round: Number(m[2]), uid: m[3], opno: Number(m[4]) } : null;
}

// ── row operations (callers open the transaction) ──
async function insert(tableId, roundNo, line, opno, actKey, now, state = "live", why = null) {
  await runQuery(
    "INSERT INTO casino_rl_lines (key, table_id, round_no, user_id, opno, bets, amount, state, why, act_key, created, closed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [line.key, tableId, roundNo, line.uid, opno, pack(line.bets || []), line.amount, state, why, actKey || null, now, state === "live" ? null : now],
  );
}
/** live -> state, once. -> true when this call made the change */
async function close(key, state, why, now) {
  if (!STATES.includes(state) || state === "live") throw Error("Bad roulette line state " + state);
  const r = await runQuery("UPDATE casino_rl_lines SET state = ?, why = ?, closed = ? WHERE key = ? AND state = 'live'", [state, why, now, key]);
  return !!r && r.changes === 1;
}
/** the spin's live set -> settled (land's transaction). -> rows changed */
async function settle(tableId, roundNo, now) {
  const r = await runQuery(
    "UPDATE casino_rl_lines SET state = 'settled', why = 'spin', closed = ? WHERE table_id = ? AND round_no = ? AND state = 'live'",
    [now, tableId, roundNo],
  );
  return (r && r.changes) || 0;
}
async function lines(tableId, roundNo, state = "live") {
  const rows = await getQuery(
    "SELECT key, user_id, amount, bets FROM casino_rl_lines WHERE table_id = ? AND round_no = ? AND state = ? ORDER BY opno",
    [tableId, roundNo, state],
  );
  return rows.map(lineOf);
}
const live = (tableId, roundNo) => lines(tableId, roundNo, "live");
async function liveKeys(tableId, roundNo) {
  return (await getQuery("SELECT key FROM casino_rl_lines WHERE table_id = ? AND round_no = ? AND state = 'live' ORDER BY opno", [tableId, roundNo])).map((r) => r.key);
}
async function maxOpno(tableId) {
  const r = await getQuery("SELECT MAX(opno) AS n FROM casino_rl_lines WHERE table_id = ?", [tableId]);
  return Number(r[0] && r[0].n) || 0;
}
/** PAT held on the wheels (supply.casinoHeld). A live row whose :refund was credited (an older build refunded it from the
 *  mirror) or whose spin landed (an older build settled it) holds nothing: the boot audit closes it, and the supply never
 *  counts that PAT twice meanwhile. */
async function held() {
  const r = await getQuery(
    `SELECT COALESCE(SUM(l.amount), 0) AS n FROM casino_rl_lines l WHERE l.state = 'live'
       AND NOT EXISTS (SELECT 1 FROM transactions x WHERE x.transactionId = l.key || ':refund')
       AND NOT EXISTS (SELECT 1 FROM casino_rounds r WHERE r.table_id = l.table_id AND r.round_no = l.round_no AND r.results IS NOT NULL)`,
  );
  return Math.max(0, Math.floor(Number(r[0] && r[0].n) || 0));
}

// ── a queued line while the wheel spins (review: no ~1 MB header write per queued action) ──
// From the draw to the landing the wheel's JSON carries the drawn book (release A's mirror), so roulette.js does not rewrite
// it for a queued line: the player's queued line - or its clearing (bets NULL) - is this row, written with the act key's
// answer. rev = the saved header's rev the change was made on: any later header save (the landing, a close) carries the
// change, so a row counts only while its rev >= the saved header's rev and its spin is the one in the air. No PAT: a queued
// line is charged when betting opens. (A rolled-back build never reads these rows: it loses those queued lines, nothing else.)
async function queue(tableId, roundNo, uid, bets, profile, rev, actKey, now) {
  await runQuery(
    "INSERT OR REPLACE INTO casino_rl_queue (table_id, user_id, round_no, rev, bets, profile, act_key, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [tableId, uid, roundNo, Number(rev) || 0, bets ? pack(bets) : null, profile ? JSON.stringify(profile) : null, actKey || null, now],
  );
}
/** the queued-line changes made on the saved header (rev) of the spin in the air -> [{uid, bets | null, profile | null}] */
async function queued(tableId, roundNo, rev) {
  const rows = await getQuery(
    "SELECT user_id, bets, profile FROM casino_rl_queue WHERE table_id = ? AND round_no = ? AND rev >= ? ORDER BY created",
    [tableId, roundNo, Number(rev) || 0],
  );
  const out = [];
  for (const r of rows) {
    let bets = null,
      profile = null;
    try {
      bets = r.bets == null ? null : unpack(r.bets);
      profile = r.profile ? JSON.parse(r.profile) : null;
    } catch (_) {
      continue; // (a position this build doesn't know: that queued line is dropped)
    }
    out.push({ uid: r.user_id, bets, profile });
  }
  return out;
}
/** the header carries the wheel's queued lines again (the landing's transaction) */
const unqueue = (tableId) => runQuery("DELETE FROM casino_rl_queue WHERE table_id = ?", [tableId]);

function flag(kind, data) {
  const f = { kind, ...data, ts: Date.now() };
  flags.push(f);
  if (flags.length > 200) flags.splice(0, flags.length - 200);
  console.warn("[casino] roulette audit: " + kind + " " + JSON.stringify(data));
  return f;
}
/** did the spin land (land writes casino_rounds.results; a close's reveal of an unused commitment does not)? */
async function landed(tableId, roundNo) {
  const r = await getQuery("SELECT results FROM casino_rounds WHERE table_id = ? AND round_no = ?", [tableId, roundNo]).catch(() => []);
  return !!(r[0] && r[0].results);
}
/** A live row nothing will settle any more (its spin is past, or its wheel is not open): settled when its spin landed
 *  (an older build landed it from the mirror's book), else refunded by its own key. -> the state it ended in */
async function resolve(r, now, why) {
  if (await money.isDone(r.key + ":refund")) {
    await close(r.key, "refunded", why, now);
    flag("live_with_refund", { key: r.key, table: r.table_id, round: r.round_no });
    return "refunded";
  }
  if (await landed(r.table_id, r.round_no)) {
    await close(r.key, "settled", why, now);
    flag("settled_elsewhere", { key: r.key, table: r.table_id, round: r.round_no });
    return "settled";
  }
  const charged = await money.isDone(r.key);
  if (charged) {
    const paid = await money.credit(r.key + ":refund", r.user_id, r.amount, "roulette refund (audit)");
    if (!paid.ok) throw Error("Wheel audit refund pending");
  }
  await close(r.key, "refunded", why, now);
  flag(charged ? "stranded_refunded" : "uncharged_closed", { key: r.key, table: r.table_id, round: r.round_no, amount: r.amount });
  return "refunded";
}

/**
 * One open wheel, as boot loaded it from its JSON: rows for the JSON's book, and every live row of the wheel checked.
 * openRound = the spin lines can be live on (null when its spin has settled). One transaction.
 */
async function reconcile(T, openRound, now) {
  await ensure();
  const book = Array.isArray(T.eng && T.eng.book) ? T.eng.book : [];
  return tx(async () => {
    let inserted = 0;
    // (review) the book's own keys by primary key - not every key the wheel ever had
    const keys = book.map((l) => l && l.key).filter((k) => typeof k === "string"),
      have = new Set();
    for (let i = 0; i < keys.length; i += 200) {
      const part = keys.slice(i, i + 200);
      for (const r of await getQuery("SELECT key FROM casino_rl_lines WHERE key IN (" + part.map(() => "?").join(", ") + ")", part)) have.add(r.key);
    }
    for (const l of book) {
      const k = l && parseKey(l.key);
      if (!k || k.table !== T.id || !(l.amount > 0) || have.has(l.key)) continue;
      const refunded = await money.isDone(l.key + ":refund");
      if (!refunded && !(await money.isDone(l.key))) {
        flag("book_line_uncharged", { key: l.key, table: T.id });
        continue;
      }
      await insert(T.id, k.round, { key: l.key, uid: l.uid || k.uid, bets: l.bets || [], amount: l.amount }, k.opno, null, now,
        refunded ? "refunded" : "live", refunded ? "migrated" : null);
      have.add(l.key);
      inserted++;
    }
    // a live row whose refund was credited (an older build ran this build's mirror refund, or a bug), and a live row of
    // any spin but the open one: neither is in force any more
    const rows = await getQuery(
      `SELECT l.* FROM casino_rl_lines l WHERE l.table_id = ? AND l.state = 'live'
         AND (l.round_no IS NOT ? OR EXISTS (SELECT 1 FROM transactions x WHERE x.transactionId = l.key || ':refund'))`,
      [T.id, openRound],
    );
    for (const r of rows) await resolve(r, now, "audit");
    return { inserted, resolved: rows.length };
  });
}

/** Live rows of wheels that are not open (closed, or gone): nothing will refund or settle them. Run once per boot whether
 *  or not any wheel is open (roulette.js bootAudit). One transaction; queued-line rows of wheels not open go with it. */
async function audit(now) {
  await ensure();
  return tx(async () => {
    const rows = await getQuery(
      "SELECT l.* FROM casino_rl_lines l LEFT JOIN casino_tables t ON t.id = l.table_id WHERE l.state = 'live' AND (t.id IS NULL OR t.status != 'open')",
    );
    for (const r of rows) await resolve(r, now, "audit");
    await runQuery("DELETE FROM casino_rl_queue WHERE table_id NOT IN (SELECT id FROM casino_tables WHERE status = 'open')");
    return rows.length;
  });
}

/**
 * Stake debits of the open spin with no row. One an older build already refunded (its undo or clear of a line in this
 * spin: the line left that build's book, so reconcile gave it no row) gets its 'refunded' row for the record ('migrated')
 * and is no finding. One with no refund (an older build charged it and stopped before its book had it) is refunded by its
 * own key, gets a 'refunded' row ('restart') and is flagged. Caller's transaction. -> [{key, uid, amount, moved}]
 */
async function strays(tableId, roundNo, now) {
  const prefix = "crl:" + tableId + ":s" + roundNo + ":";
  const debits = await getQuery(
    `SELECT t.transactionId AS key, t.userId AS uid, t.points,
            EXISTS (SELECT 1 FROM transactions r WHERE r.transactionId = t.transactionId || ':refund') AS refunded
       FROM transactions t
      WHERE t.transactionId GLOB ? AND t.points < 0 AND NOT EXISTS (SELECT 1 FROM casino_rl_lines l WHERE l.key = t.transactionId)`,
    [prefix.replace(/[*?[\]]/g, (c) => "[" + c + "]") + "*"],
  );
  const out = [];
  for (const d of debits) {
    const k = parseKey(d.key);
    if (!k || k.table !== tableId || k.round !== roundNo) continue;
    const amount = -Number(d.points);
    if (d.refunded) {
      await insert(tableId, roundNo, { key: d.key, uid: k.uid, bets: [], amount }, k.opno, null, now, "refunded", "migrated");
      out.push({ key: d.key, uid: k.uid, amount, moved: false });
      continue;
    }
    const paid = await money.credit(d.key + ":refund", d.uid, amount, "roulette refund (restart)");
    if (!paid.ok) throw Error("Stake recovery pending");
    await insert(tableId, roundNo, { key: d.key, uid: k.uid, bets: [], amount }, k.opno, null, now, "refunded", "restart");
    if (!paid.replay) flag("stray_stake_refunded", { key: d.key, table: tableId, round: roundNo, amount });
    out.push({ key: d.key, uid: k.uid, amount, moved: !paid.replay });
  }
  return out;
}

module.exports = {
  ensure,
  pack,
  unpack,
  bet,
  lineOf,
  parseKey,
  insert,
  close,
  settle,
  lines,
  live,
  liveKeys,
  maxOpno,
  held,
  queue,
  queued,
  unqueue,
  reconcile,
  audit,
  strays,
  flags,
  STATES,
};
