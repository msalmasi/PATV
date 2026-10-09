// orphantx.js — 1.99ga: transaction rows whose userId has no users row ("orphans").
//
// 2026-10-08 audit: 2,604 rows / 59 ids. Most are history of accounts deleted or merged by hand before
// merges moved history (spring 2026); one was a live race (an achievement payout logged against a
// Camfrog auto-account a !verify merge had just deleted). ledger.js stops new ones; this file
//   * reports what is left (report(): admin panel / GET /api/admin/ledger/orphans; rows staff made good
//     are RESOLVED - listed by resolved(), counted nowhere else), and
//   * plans + applies the one-shot clean-up (fix-orphan-transactions.js): rows of a merged-away account
//     whose survivor is known (account_merges, the site log's [CF-MERGE] / [auth] merge lines, or a
//     staff-made map) move to the survivor with a note suffix. Balances never change:
//       - rows dated before the merge are history the merge already carried (the balance moved, the
//         rows didn't) -> relabelled; one "ledger-correction" offset row keeps the survivor's ledger
//         adding up to its balance (skipped when the balance already includes them exactly);
//       - rows dated after the merge never reached any balance -> left where they are and listed as
//         possibly lost credits for a manual make-good decision.
//   Ids with no known survivor are left as they are (report only).
//
// Everything takes q(sql, params) -> rows and run(sql, params) -> {changes}, so the script can work on
// a read-only handle of any database file and the site on its own connection.
"use strict";

const SUFFIX = "(reattributed from merged account)";
const OFFSET_PREFIX = "reattr-offset-";

// "2026-10-08T14:46:40.362Z" -> "2026-10-08 14:46:40" (the transactions.timestamp format, UTC)
const sqlTime = (iso) => String(iso).replace("T", " ").replace(/\.\d+Z?$/, "").replace(/Z$/, "").slice(0, 19);

/**
 * Merges from the site's pm2 log. A line has no time of its own, so each merge gets the window between
 * the last timestamped line before it ("after") and the first one after it ("before").
 *   [CF-MERGE] Merging auto account <old> into <new>: +PAT <n>, +XP <x>
 *   [auth] twitch|discord merge <old> -> <new>: +<n> PAT, ...
 */
function mergeLogParser() {
  const out = [];
  const pending = [];
  const ID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
  const cf = new RegExp(`\\[CF-MERGE\\] Merging auto account ${ID} into ${ID}: \\+PAT (-?\\d+)`);
  const oauth = new RegExp(`\\[auth\\] (twitch|discord) merge ${ID} -> ${ID}: \\+(-?\\d+) PAT`);
  const stamp = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\]/;
  let last = null;
  return {
    line(line) {
      if (line.charCodeAt(0) === 91 /* [ */) {
        const t = stamp.exec(line);
        if (t) {
          const ts = sqlTime(t[1]);
          for (const m of pending.splice(0)) m.before = ts;
          last = ts;
          return;
        }
      }
      if (line.indexOf("merge") < 0 && line.indexOf("MERGE") < 0) return;
      let m = cf.exec(line);
      if (m) { const e = { old: m[1], new: m[2], via: "camfrog link (log)", oldBalance: Number(m[3]), after: last, before: null }; out.push(e); pending.push(e); return; }
      m = oauth.exec(line);
      if (m) { const e = { old: m[2], new: m[3], via: `${m[1]} merge (log)`, oldBalance: Number(m[4]), after: last, before: null }; out.push(e); pending.push(e); }
    },
    done() { return out; },
  };
}
function parseMergeLog(text) {
  const p = mergeLogParser();
  for (const line of String(text || "").split(/\r?\n/)) p.line(line);
  return p.done();
}

/** A staff-made map: one "<old> <new> [YYYY-MM-DD HH:MM:SS]" per line, # comments. */
function parseMap(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [oldId, newId, d, t] = line.split(/\s+/);
    if (!oldId || !newId) continue;
    out.push({ old: oldId, new: newId, via: "staff map", at: d ? `${d}${t ? " " + t : ""}` : null });
  }
  return out;
}

async function hasTable(q, t) { return (await q("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0; }
async function hasColumn(q, t, c) { return (await q(`SELECT name FROM pragma_table_info('${t}')`)).some((r) => r.name === c); }

// 1.99gg: an orphan row staff have already made good (the credit was paid to the right account by hand) is
// RESOLVED: its note says "(made good to <user> <id> via <ref>)". Resolved rows stay where they are, are listed
// separately (resolved()), and count nowhere else - not in report()'s ids / rows / net, not in plan().
const MADE_GOOD = "made good to";
/** SQL condition (on alias `t`) for "not resolved"; "" when transactions has no note column. */
async function unresolvedSql(q) {
  return (await hasColumn(q, "transactions", "note")) ? ` AND (t.note IS NULL OR instr(LOWER(t.note), '${MADE_GOOD}') = 0)` : "";
}

/** Every orphan id with UNRESOLVED rows: rows, net, date range, types, and whether it sits in account_archive.
 *  (Made-good rows are excluded here - see resolved().) */
async function report(q) {
  const open = await unresolvedSql(q);
  const ids = await q(`SELECT t.userId, COUNT(*) AS rows, COALESCE(SUM(t.points), 0) AS net,
                              MIN(t.timestamp) AS first, MAX(t.timestamp) AS last
                       FROM transactions t LEFT JOIN users u ON u.userId = t.userId
                       WHERE u.userId IS NULL${open} GROUP BY t.userId ORDER BY last DESC`);
  const arch = (await hasTable(q, "account_archive")) ? new Set((await q("SELECT userId FROM account_archive")).map((r) => r.userId)) : new Set();
  const merges = (await hasTable(q, "account_merges")) ? new Map((await q("SELECT old_id, new_id FROM account_merges")).map((r) => [r.old_id, r.new_id])) : new Map();
  for (const r of ids) {
    r.archived = arch.has(r.userId);
    r.mergedInto = merges.get(r.userId) || null;
    r.types = await q(`SELECT type, COUNT(*) AS rows, COALESCE(SUM(points), 0) AS net FROM transactions t WHERE userId = ?${open}
                       GROUP BY type ORDER BY rows DESC`, [r.userId]);
  }
  return ids;
}

/** The RESOLVED orphan rows (made good by staff), one entry per row, newest first. */
async function resolved(q) {
  if (!(await hasColumn(q, "transactions", "note"))) return [];
  const rows = await q(`SELECT t.transactionId, t.userId, t.type, t.points, t.timestamp, t.note
                        FROM transactions t LEFT JOIN users u ON u.userId = t.userId
                        WHERE u.userId IS NULL AND instr(LOWER(t.note), '${MADE_GOOD}') > 0
                        ORDER BY t.timestamp DESC, t.transactionId`);
  for (const r of rows) {
    const m = /made good to\s+(\S+)(?:\s+([0-9a-f-]{6,}))?(?:\s+via\s+([^)\s]+))?/i.exec(String(r.note || ""));
    r.points = Number(r.points) || 0;
    r.madeGoodTo = m ? m[1] : null;
    r.madeGoodId = m && m[2] ? m[2] : null;
    r.ref = m && m[3] ? m[3] : null;
  }
  return rows;
}

/** old -> {new, via, after, before, at, oldBalance}: account_merges first, then the extra sources (later wins). */
async function mergeMap(q, extra) {
  const map = new Map();
  if (await hasTable(q, "account_merges")) {
    for (const r of await q("SELECT old_id, new_id, merged_at, via FROM account_merges")) {
      map.set(r.old_id, { old: r.old_id, new: r.new_id, via: r.via || "account_merges",
                          at: r.merged_at ? sqlTime(new Date(Number(r.merged_at)).toISOString()) : null });
    }
  }
  // provider merges since 1.99fy leave an account_archive row (tier MERGE) whose snapshot names the survivor
  if ((await hasTable(q, "account_archive")) && (await hasColumn(q, "account_archive", "snapshot")) && (await hasColumn(q, "account_archive", "tier"))) {
    for (const r of await q("SELECT userId, archived_at, snapshot FROM account_archive WHERE tier = 'MERGE'")) {
      let to = null;
      try { to = JSON.parse(r.snapshot || "{}").merged_into || null; } catch (e) { /* not JSON */ }
      if (to && !map.has(r.userId)) {
        map.set(r.userId, { old: r.userId, new: to, via: "account_archive MERGE",
                            at: r.archived_at ? sqlTime(new Date(Number(r.archived_at)).toISOString()) : null });
      }
    }
  }
  for (const e of extra || []) map.set(e.old, e);
  return map;
}

async function live(q, id) {
  const r = await q("SELECT userId, points_balance FROM users WHERE userId = ?", [id]);
  return r.length ? r[0] : null;
}

/** Follow old -> new until a live account (max 6 hops). */
async function survivorOf(q, map, id) {
  let cur = id;
  const path = [];
  for (let hop = 0; hop < 6; hop++) {
    const e = map.get(cur);
    if (!e) return null;
    path.push(e);
    const u = await live(q, e.new);
    if (u) return { userId: e.new, balance: Number(u.points_balance) || 0, merge: path[0], path };
    cur = e.new;
  }
  return null;
}

/**
 * The clean-up plan. {survivors: [...], lost: [...], noSurvivor: [...], totals}
 *   survivor: {survivor, balance, ledgerSum, gap, olds: [{old, via, rows: [ids], net, lostRows}], moveNet, offset}
 */
async function plan(q, extraMerges) {
  const orphans = await report(q);
  const map = await mergeMap(q, extraMerges);
  const bySurvivor = new Map();
  const lost = [];
  const noSurvivor = [];
  for (const o of orphans) {
    const s = await survivorOf(q, map, o.userId);
    if (!s) { noSurvivor.push(o); continue; }
    const m = s.merge;
    const rows = await q(`SELECT transactionId, type, points, timestamp FROM transactions t WHERE userId = ?${await unresolvedSql(q)}
                          ORDER BY timestamp, transactionId`, [o.userId]);   // made-good rows stay put (resolved)
    let entry = bySurvivor.get(s.userId);
    if (!entry) {
      const sum = (await q("SELECT COALESCE(SUM(points), 0) AS s FROM transactions WHERE userId = ?", [s.userId]))[0].s;
      entry = { survivor: s.userId, balance: s.balance, ledgerSum: Number(sum) || 0, gap: s.balance - (Number(sum) || 0), olds: [], moveNet: 0, offset: 0 };
      bySurvivor.set(s.userId, entry);
    }
    const hist = [], late = [], window = [];
    for (const r of rows) {
      const ts = String(r.timestamp || "");
      if (m.at) (ts <= m.at ? hist : late).push(r);
      else if (m.after !== undefined || m.before !== undefined) {
        if (m.after && ts < m.after) hist.push(r);
        else if (m.before && ts > m.before) late.push(r);
        else if (!m.after && !m.before) hist.push(r);
        else window.push(r);
      } else hist.push(r);
    }
    // inside the log's time window: history if the survivor's balance shows it, else it never landed
    if (window.length) {
      const wnet = window.reduce((t, r) => t + Number(r.points || 0), 0);
      if (wnet !== 0 && entry.gap === wnet) hist.push(...window); else late.push(...window);
    }
    const net = hist.reduce((t, r) => t + Number(r.points || 0), 0);
    entry.olds.push({ old: o.userId, via: m.via, oldBalance: m.oldBalance, rows: hist.map((r) => r.transactionId), net,
                      first: hist.length ? hist[0].timestamp : null, last: hist.length ? hist[hist.length - 1].timestamp : null,
                      lostRows: late.length });
    entry.moveNet += net;
    for (const r of late) lost.push({ survivor: s.userId, old: o.userId, transactionId: r.transactionId, type: r.type, points: Number(r.points), timestamp: r.timestamp });
  }
  for (const e of bySurvivor.values()) {
    // balance already holds the rows exactly (gap == their net): moving them closes the gap, no offset;
    // otherwise (the ledger was already squared, e.g. by the 2026-10-03 ledger-correction) an offset keeps it as it is
    e.offset = e.moveNet === 0 || e.gap === e.moveNet ? 0 : -e.moveNet;
    const nRows = e.olds.reduce((t, o) => t + o.rows.length, 0);
    e.balanceReflects = !nRows ? "n/a - no history rows to move (only post-merge rows, listed as possibly lost)"
      : e.gap === e.moveNet ?"yes - the balance holds them, the ledger lacked them (rows close the gap)"
      : e.gap === 0 ? "yes - balance moved with the merge and the ledger was already squared to it; relabel + offset"
      : `unclear - ledger gap ${e.gap} vs rows ${e.moveNet}; relabel + offset keeps the gap as it is`;
  }
  const survivors = [...bySurvivor.values()];
  const totals = {
    orphanIds: orphans.length,
    orphanRows: orphans.reduce((t, o) => t + o.rows, 0),
    toMoveRows: survivors.reduce((t, s) => t + s.olds.reduce((u, o) => u + o.rows.length, 0), 0),
    lostRows: lost.length, lostNet: lost.reduce((t, r) => t + r.points, 0),
    noSurvivorIds: noSurvivor.length, noSurvivorRows: noSurvivor.reduce((t, o) => t + o.rows, 0),
  };
  return { survivors, lost, noSurvivor, totals, merges: [...map.values()] };
}

/** Apply a plan made on the same database. Balances are checked untouched; throws (caller rolls back) if not. */
async function apply(q, run, p) {
  const balBefore = (await q("SELECT COALESCE(SUM(points_balance), 0) AS s, COUNT(*) AS n FROM users"))[0];
  const hasNote = await hasColumn(q, "transactions", "note");
  const hasCp = await hasColumn(q, "transactions", "counterparty");
  await run(`CREATE TABLE IF NOT EXISTS account_merges (old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL, merged_at INTEGER NOT NULL, via TEXT)`);
  let moved = 0, offsets = 0, cps = 0;
  for (const s of p.survivors) {
    for (const o of s.olds) {
      for (const id of o.rows) {
        const r = hasNote
          ? await run(`UPDATE transactions SET userId = ?, note = CASE WHEN note IS NULL OR note = '' THEN ? ELSE note || ' ' || ? END
                       WHERE transactionId = ? AND userId = ?`, [s.survivor, SUFFIX, SUFFIX, id, o.old])
          : await run("UPDATE transactions SET userId = ? WHERE transactionId = ? AND userId = ?", [s.survivor, id, o.old]);
        moved += (r && r.changes) || 0;
      }
      if (hasCp) cps += ((await run("UPDATE transactions SET counterparty = ? WHERE counterparty = ?", [s.survivor, o.old])) || {}).changes || 0;
      await run("INSERT OR IGNORE INTO account_merges (old_id, new_id, merged_at, via) VALUES (?, ?, ?, ?)",
                [o.old, s.survivor, Date.now(), String(o.via || "reattribution").slice(0, 60)]);
    }
    if (s.offset) {
      const id = OFFSET_PREFIX + s.survivor + "-" + s.olds.map((o) => o.old.slice(0, 8)).join("-");
      const note = `offsets the ${s.olds.reduce((t, o) => t + o.rows.length, 0)} rows reattributed from merged account(s) ${s.olds.map((o) => o.old).join(", ")} - balance unchanged`;
      const r = hasNote
        ? await run("INSERT OR IGNORE INTO transactions (transactionId, userId, type, points, note) VALUES (?, ?, 'ledger-correction', ?, ?)", [id, s.survivor, s.offset, note])
        : await run("INSERT OR IGNORE INTO transactions (transactionId, userId, type, points) VALUES (?, ?, 'ledger-correction', ?)", [id, s.survivor, s.offset]);
      offsets += (r && r.changes) || 0;
    }
  }
  const balAfter = (await q("SELECT COALESCE(SUM(points_balance), 0) AS s, COUNT(*) AS n FROM users"))[0];
  if (Number(balAfter.s) !== Number(balBefore.s) || Number(balAfter.n) !== Number(balBefore.n)) {
    throw new Error(`balances changed (${balBefore.s} -> ${balAfter.s}) - refusing`);
  }
  return { moved, offsets, counterparties: cps };
}

module.exports = { parseMergeLog, mergeLogParser, parseMap, report, resolved, MADE_GOOD, plan, apply, mergeMap, SUFFIX, OFFSET_PREFIX, sqlTime };
