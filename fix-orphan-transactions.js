#!/usr/bin/env node
// fix-orphan-transactions.js — 1.99ga one-shot: re-home the transaction rows of merged-away accounts.
//
//   node fix-orphan-transactions.js [--db=./myapp.db] [--pm2-log=/root/.pm2/logs/index-out.log]
//                                   [--map=hand-merges.txt] [--json] [--dry-run | --apply [--no-backup]]
//
// Dry run (the default, and --dry-run) opens the database READ-ONLY and prints the plan:
//   * per survivor: the merged-away ids, the rows that move (with the note suffix
//     "(reattributed from merged account)"), their net, the survivor's balance / ledger gap and whether
//     the balance already includes them, and the offset row (if any) that keeps the ledger adding up;
//   * rows written AFTER the merge (they never reached a balance): possible lost credits - listed for a
//     manual make-good decision, never moved or credited;
//   * ids with no known survivor: left as they are.
// --apply: VACUUM INTO a backup next to the database first (unless --no-backup), then the whole plan in
// ONE transaction; balances are checked unchanged (else rolled back). Re-running is a no-op.
// Survivors come from account_merges (written by every merge since 1.99ga), the site log's
// [CF-MERGE] / [auth] merge lines (--pm2-log) and a staff map (--map: "<old> <new> [YYYY-MM-DD HH:MM:SS]").
"use strict";
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");
const ot = require("./orphantx");

function args(argv) {
  const a = { db: "./myapp.db", apply: false, json: false, backup: true };
  for (const s of argv) {
    if (s === "--apply") a.apply = true;
    else if (s === "--dry-run") a.apply = false;
    else if (s === "--json") a.json = true;
    else if (s === "--no-backup") a.backup = false;
    else if (s.startsWith("--db=")) a.db = s.slice(5);
    else if (s.startsWith("--pm2-log=")) a.log = s.slice(10);
    else if (s.startsWith("--map=")) a.map = s.slice(6);
    else throw new Error(`unknown argument ${s}`);
  }
  if (argv.includes("--apply") && argv.includes("--dry-run")) throw new Error("--apply and --dry-run together");
  return a;
}

function open(file, readonly) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, readonly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE, (e) => (e ? reject(e) : resolve(db)));
  });
}
const qOf = (db) => (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const runOf = (db) => (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { return e ? rej(e) : res({ changes: this.changes }); }));

const fmt = (n) => Number(n || 0).toLocaleString("en-US");

function print(p, applied) {
  const t = p.totals;
  console.log(`orphan ids ${t.orphanIds} / rows ${fmt(t.orphanRows)}; merges known ${p.merges.length}`);
  console.log(`\n== reattribute (survivor known): ${p.survivors.length} survivor(s), ${fmt(t.toMoveRows)} row(s)`);
  for (const s of p.survivors) {
    console.log(`  survivor ${s.survivor}: balance ${fmt(s.balance)}, ledger sum ${fmt(s.ledgerSum)}, gap ${fmt(s.gap)}`);
    for (const o of s.olds) {
      console.log(`    <- ${o.old} via ${o.via}${o.oldBalance !== undefined ? ` (merge carried +PAT ${fmt(o.oldBalance)})` : ""}: ` +
                  `${fmt(o.rows.length)} row(s), net ${fmt(o.net)}${o.first ? `, ${o.first} .. ${o.last}` : ""}${o.lostRows ? `, ${o.lostRows} post-merge row(s) left` : ""}`);
    }
    console.log(`    balance already includes them: ${s.balanceReflects}; offset row ${s.offset ? fmt(s.offset) : "none"}`);
  }
  console.log(`\n== possibly lost credits (written after the merge, never reached a balance): ${t.lostRows} row(s), net ${fmt(t.lostNet)}`);
  for (const l of p.lost) console.log(`  ${l.timestamp}  ${fmt(l.points)} PAT  "${l.type}"  old ${l.old} -> survivor ${l.survivor}`);
  console.log(`\n== no known survivor (left as they are): ${t.noSurvivorIds} id(s), ${fmt(t.noSurvivorRows)} row(s), net ${fmt(p.noSurvivor.reduce((u, o) => u + o.net, 0))}`);
  for (const o of p.noSurvivor) console.log(`  ${o.userId}: ${o.rows} row(s), net ${fmt(o.net)}, ${o.first} .. ${o.last}${o.archived ? " (archived)" : ""}`);
  if (applied) console.log(`\nAPPLIED: ${applied.moved} row(s) moved, ${applied.offsets} offset row(s), ${applied.counterparties} counterparty ref(s) updated`);
  else console.log("\nDRY RUN - nothing written (run with --apply to do it)");
}

async function main() {
  const a = args(process.argv.slice(2));
  const extra = [];
  if (a.log) {   // streamed: the site's pm2 log runs to gigabytes
    const parser = ot.mergeLogParser();
    const rl = require("readline").createInterface({ input: fs.createReadStream(a.log, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) parser.line(line);
    extra.push(...parser.done());
  }
  if (a.map) extra.push(...ot.parseMap(fs.readFileSync(a.map, "utf8")));
  const db = await open(a.db, !a.apply);
  const q = qOf(db), run = runOf(db);
  await q("PRAGMA busy_timeout = 5000").catch(() => {});
  try {
    if (!a.apply) {
      const p = await ot.plan(q, extra);
      if (a.json) console.log(JSON.stringify(p, null, 1)); else print(p, null);
      return;
    }
    if (a.backup) {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      const to = path.join(path.dirname(path.resolve(a.db)), `myapp-before-orphan-reattr-${stamp}.db`);
      await run(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
      console.log(`backup: ${to}`);
    }
    await run("BEGIN IMMEDIATE");
    let p, done;
    try {
      p = await ot.plan(q, extra);
      done = await ot.apply(q, run, p);
      await run("COMMIT");
    } catch (e) {
      await run("ROLLBACK").catch(() => {});
      throw e;
    }
    if (a.json) console.log(JSON.stringify({ plan: p, applied: done }, null, 1)); else print(p, done);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("fix-orphan-transactions:", e.message); process.exit(1); });
}
module.exports = { args };
