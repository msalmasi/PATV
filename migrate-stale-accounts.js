// migrate-stale-accounts.js - 1.99bm: classify stale / junk accounts and (only with --apply) archive them,
// reclaiming their balances to the Federal Reserve. See staleaccounts.js for the tiers and the money path.
//
// DRY RUN BY DEFAULT: without --apply nothing is written - not even the archive column.
//
//   node migrate-stale-accounts.js [--dir=<folder with myapp.db>] [--bot-dir=<copies of Pepe's data files>]
//        [--tiers=A,B,C,G,A2 (1.99bs: A2 in by default)] [--tier-a-days=90] [--dormant-days=180] [--low-max=3]
//        [--low-days=2] [--bot-keep-min=100000] [--bot-keep-any=150000] [--sensitivity] [--export=<file.json>] [--now=<ISO date>]
//   ... --notice --apply-on=YYYY-MM-DD [--apply]   start the warning window: mark the selected accounts
//                                                  pending (inbox notice each; Pepe PMs the Camfrog logins
//                                                  when he sees them; any activity clears it)
//   ... --notice-refresh [--apply]                 clear pending accounts that are active again
//   ... --apply [--backup-dir=<dir>] [--limit=N]   archive the selected tiers (backup first, always).
//                                                  With a notice run: only accounts still pending AND still
//                                                  in a selected tier, and not before its apply date
//                                                  (--force-early overrides; --ignore-notice skips the list)
//   ... --merge-dups [--apply]                     merge tier M duplicates into their primary account (the
//                                                  copy's duplicate welcome mint goes to the Reserve)
//   ... --purge [--apply]                          hard-delete tier A rows past their grace period
//   ... --rollback=<runId> [--apply]               restore every account a run archived
//
// --bot-dir reads (when present) userstats.json, greeter_seen.json, activity.json, loans.json,
// escrow.json, pvaults.json, gang_data.json, markets.json, bounties.json, wagers.json, lotto.json and
// shared.json (or memories/shared.json). Copy them off Pepe's machine; this never touches the originals.
// Output never contains email addresses - only email categories.
"use strict";
const fs = require("fs");
const path = require("path");

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const appDir = __dirname;
if (args.dir) process.chdir(path.resolve(String(args.dir)));         // dbUtils opens ./myapp.db
if (!fs.existsSync(path.join(process.cwd(), "myapp.db"))) { console.error(`no myapp.db in ${process.cwd()}`); process.exit(2); }
const { runQuery, getQuery } = require(path.join(appDir, "dbUtils"));
const stale = require(path.join(appDir, "staleaccounts"));

const num = (k, d) => (args[k] === undefined ? d : Number(args[k]));
const opts = {
  tierADays: num("tier-a-days", stale.DEFAULTS.tierADays), dormantDays: num("dormant-days", stale.DEFAULTS.dormantDays),
  lowMax: num("low-max", stale.DEFAULTS.lowMax), lowDays: num("low-days", stale.DEFAULTS.lowDays),
  graceDays: num("grace-days", stale.DEFAULTS.graceDays), botKeepMin: num("bot-keep-min", stale.DEFAULTS.botKeepMin),
  botKeepAny: num("bot-keep-any", stale.DEFAULTS.botKeepAny),
};
const now = args.now ? Date.parse(String(args.now)) : Date.now();
const apply = !!args.apply;
const tiers = String(args.tiers || stale.DEFAULT_TIERS.join(",")).toUpperCase().split(",").map((s) => s.trim()).filter((t) => ["A", "B", "C", "G", "A2"].includes(t));

function readBot(dir) {
  if (!dir) return null;
  const rd = (...names) => {
    for (const n of names) {
      const p = path.join(String(dir), n);
      if (fs.existsSync(p)) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { console.error(`  (could not parse ${n}: ${e.message})`); } }
    }
    return null;
  };
  return { userstats: rd("userstats.json"), greeter: rd("greeter_seen.json"), activity: rd("activity.json"), loans: rd("loans.json"),
    escrow: rd("escrow.json"), pvaults: rd("pvaults.json"), gangs: rd("gang_data.json"), markets: rd("markets.json"),
    bounties: rd("bounties.json"), wagers: rd("wagers.json"), lotto: rd("lotto.json"), shared: rd("shared.json", path.join("memories", "shared.json")) };
}

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(2) + "%" : "-");

async function backup(dir) {
  const d = path.resolve(String(dir || "db-backups"));
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, `myapp-pre-stale-${new Date(now).toISOString().replace(/[:.]/g, "-")}.db`);
  await runQuery(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const size = fs.statSync(file).size;
  if (size < 4096) throw new Error("backup looks empty");
  return { file, size };
}

(async () => {
  const bot = readBot(args["bot-dir"]);

  if (args.rollback) {
    const runId = String(args.rollback);
    const rows = await getQuery("SELECT userId, reclaimed FROM account_archive WHERE run_id = ? AND restored_at IS NULL AND purged_at IS NULL", [runId]).catch(() => []);
    const pat = rows.reduce((t, r) => t + (Number(r.reclaimed) || 0), 0);
    console.log(`${apply ? "ROLLBACK" : "DRY RUN rollback"} of run ${runId}: ${rows.length} account(s), ${fmt(pat)} PAT back from the Reserve`);
    if (apply) {
      const b = await backup(args["backup-dir"]); console.log(`backup: ${b.file} (${fmt(b.size)} bytes)`);
      let n = 0; for (const r of rows) if (await stale.restore(r.userId, "rollback " + runId)) n++;
      console.log(`restored ${n}`);
    }
    process.exit(0);
  }

  if (args["merge-dups"]) {
    const p = await stale.plan(Object.assign({ now, bot }, opts));
    const mr = p.rows.filter((r) => r.tier === "M");
    const names = new Map(p.facts.map((f) => [f.userId, f.username]));
    console.log(`${apply ? "MERGE" : "DRY RUN merge"}: ${mr.length} duplicate account(s)`);
    let toMain = 0, toRes = 0;
    for (const r of mr) {
      const s = await stale.dupSplit(r.f.userId);
      toMain += s.toMain; toRes += s.toReserve;
      console.log(`  ${r.f.username} (${fmt(r.f.balance)} PAT: ${fmt(s.toMain)} to ${names.get(r.f.dupOf)}, ${fmt(s.toReserve)} duplicate welcome mint to the Reserve)  [${r.f.dupWhy}]`);
    }
    console.log(`  total: ${fmt(toMain)} PAT to the primaries, ${fmt(toRes)} PAT to the Federal Reserve`);
    if (apply) {
      const b = await backup(args["backup-dir"]); console.log(`backup: ${b.file} (${fmt(b.size)} bytes)`);
      let n = 0; for (const r of mr) if (await stale.mergeDuplicate(r.f.userId, r.f.dupOf)) n++;
      console.log(`merged ${n}`);
    }
    process.exit(0);
  }

  if (args["notice-refresh"]) {
    if (!apply) {
      const pend = await getQuery("SELECT userId FROM stale_notice WHERE state = 'pending'").catch(() => []);
      const p = await stale.plan(Object.assign({ now, bot }, opts));
      const meta = ((await getQuery("SELECT 1 FROM sqlite_master WHERE name = 'stale_meta'")).length && (await stale.noticeMeta())) || {};
      const sel = meta.tiers || stale.DEFAULT_TIERS;
      const tierOf = new Map(p.rows.map((r) => [r.f.userId, r.tier]));
      const back = pend.filter((x) => !sel.includes(tierOf.get(x.userId)) && tierOf.get(x.userId) !== "archived");
      console.log(`DRY RUN notice refresh: ${pend.length} pending, ${back.length} active again (would be cleared)`);
      process.exit(0);
    }
    const r = await stale.refreshNotice({ now, bot, opts });
    console.log(`notice refresh: ${r.checked} pending checked, ${r.cleared} cleared (active again)`);
    process.exit(0);
  }

  if (args.purge) {
    if (apply) { const b = await backup(args["backup-dir"]); console.log(`backup: ${b.file} (${fmt(b.size)} bytes)`); }
    const r = await stale.purge({ now, dryRun: !apply, bot });
    console.log(`${apply ? "PURGED" : "DRY RUN purge"}: due ${r.due}, ${apply ? "deleted" : "would delete"} ${r.purged}, skipped ${r.skipped.length}`);
    for (const s of r.skipped.slice(0, 30)) console.log(`  skip ${s.userId}: ${s.why}`);
    process.exit(0);
  }

  const p = await stale.plan(Object.assign({ now, bot }, opts));
  const S = p.supply;
  console.log(`${apply ? "APPLY" : "DRY RUN"} at ${new Date(now).toISOString()}  thresholds: A unseen >= ${opts.tierADays}d; B/C/D dormant >= ${opts.dormantDays}d; low activity <= ${opts.lowMax} action(s) on <= ${opts.lowDays} day(s)${bot ? "; with Pepe's data" : "; site data only"}`);
  console.log(`supply: total ${fmt(S.total)} = wallets ${fmt(S.wallets)} + casino jackpot ${fmt(S.jackpot)} + Pepe's pools ${fmt(S.pools)}`);
  console.log("tier        accounts            PAT   % supply  % wallets");
  for (const t of ["A", "B", "C", "G", "A2", "A2M", "M", "D", "X", "active", "archived"]) {
    const v = p.tiers[t] || { n: 0, pat: 0 };
    console.log(`${t.padEnd(9)} ${String(v.n).padStart(10)} ${fmt(v.pat).padStart(14)} ${pct(v.pat, S.total).padStart(10)} ${pct(v.pat, S.wallets).padStart(10)}`);
  }
  const sel = p.rows.filter((r) => tiers.includes(r.tier));
  const selPat = sel.reduce((t, r) => t + Math.max(0, Math.floor(r.f.balance)), 0);
  console.log(`selected (${tiers.join("+")}): ${sel.length} account(s), ${fmt(selPat)} PAT -> Federal Reserve (${pct(selPat, S.total)} of supply; total supply unchanged, it moves from wallets to the Reserve)`);

  // breakdowns
  const by = (rows, key) => rows.reduce((m, r) => { const k = key(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  const xr = p.rows.filter((r) => r.tier === "X");
  const reasons = {};
  for (const r of xr) for (const w of r.why.split("; ")) { const k = w.replace(/\(.*\)/, "").replace(/role: .*/, "role").trim(); reasons[k] = (reasons[k] || 0) + 1; }
  console.log("exclusions (an account can have several):", JSON.stringify(reasons));
  console.log("A by balance:", JSON.stringify(by(p.rows.filter((r) => r.tier === "A"), (r) => (r.f.balance < 1 ? "0" : r.f.balance < 50000 ? "<50k" : r.f.balance < 500000 ? "<500k" : r.f.balance < 5e6 ? "<5M" : ">=5M"))));
  console.log("C by email category:", JSON.stringify(by(p.rows.filter((r) => r.tier === "C"), (r) => r.f.email + (r.f.verified ? "" : "/unverified"))));
  console.log("D by reason:", JSON.stringify(by(p.rows.filter((r) => r.tier === "D"), (r) => r.why.replace(/^dormant \d+d, /, ""))));
  const cp = sel.filter((r) => r.f.cpRefs > 0);
  console.log(`selected accounts referenced as a counterparty in others' history: ${cp.length}`);
  const ghosts = p.rows.filter((r) => r.f.ghost);
  console.log(`ownerless ghosts: ${ghosts.map((r) => `${r.f.username}=${r.tier}/${fmt(r.f.balance)} PAT`).join(", ") || "none"}`);
  const a2m = p.rows.filter((r) => r.tier === "A2M");
  console.log(`bot accounts proposed for a merge instead (A2M, never selected): ${a2m.map((r) => `${r.f.username}=${fmt(r.f.balance)} PAT -> ${r.f.idMatch}`).join(", ") || "none"}`);
  const bots = p.rows.filter((r) => r.f.botMade);
  const byT = bots.reduce((m, r) => { const v = m[r.tier] || (m[r.tier] = { n: 0, pat: 0 }); v.n++; v.pat += Math.max(0, Math.floor(r.f.balance)); return m; }, {});
  console.log(`Twitch/Discord-bot accounts by tier: ${Object.entries(byT).map(([t, v]) => `${t} ${v.n} / ${fmt(v.pat)} PAT`).join("; ")}`);
  const mr = p.rows.filter((r) => r.tier === "M");
  console.log(`duplicates to merge (M): ${mr.length} account(s), ${fmt(mr.reduce((t, r) => t + Math.max(0, r.f.balance), 0))} PAT (moves to the primary account, not the Reserve); ` +
              `${new Set(mr.map((r) => r.f.dupOf)).size} primary account(s)`);
  const quiet = p.rows.filter((r) => r.tier === "active" && r.f.isCF && r.f.activeN === 0 && !(r.f.tips || r.f.purchases || r.f.badges || r.f.cosmetics));
  console.log(`still "active" but never did anything themselves (auto accounts, seen < ${opts.tierADays}d): ${quiet.length} account(s), ${fmt(quiet.reduce((t, r) => t + Math.max(0, Math.floor(r.f.balance)), 0))} PAT`);
  const xs = p.rows.filter((r) => r.tier === "X" && r.f.isCF && r.f.activeN === 0 && !(r.f.tips || r.f.purchases || r.f.badges || r.f.cosmetics));
  console.log(`excluded auto accounts with no own activity (held only by a hold): ${xs.length}`);
  const top = sel.slice().sort((a, b) => b.f.balance - a.f.balance).slice(0, Number(args.top || 10));
  console.log(`largest selected balances:`);
  for (const r of top) console.log(`  ${r.tier} ${r.f.username.padEnd(12)} ${fmt(r.f.balance).padStart(12)} PAT  ${r.why}`);

  if (args.sensitivity) {
    console.log("\nsensitivity (A uses the days as its unseen threshold too):");
    console.log("days  low-max   A n / PAT              B n / PAT              C n / PAT              A2 n / PAT             D n / PAT");
    for (const d of [90, 180, 365]) for (const lm of [1, 3, 5, 10]) {
      const q = await stale.plan(Object.assign({ now, facts: p.facts, supply: S }, opts, { tierADays: d, dormantDays: d, lowMax: lm }));
      const c = (t) => { const v = q.tiers[t] || { n: 0, pat: 0 }; return `${String(v.n).padStart(4)} / ${fmt(v.pat).padStart(12)}`; };
      console.log(`${String(d).padStart(4)} ${String(lm).padStart(8)}   ${c("A")}    ${c("B")}    ${c("C")}    ${c("A2")}    ${c("D")}`);
    }
  }

  if (args.notice) {
    const applyOn = String(args["apply-on"] || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(applyOn)) { console.error("--notice needs --apply-on=YYYY-MM-DD"); process.exit(2); }
    const purgeOn = new Date(Date.parse(applyOn + "T00:00:00Z") + opts.graceDays * 86400000).toISOString().slice(0, 10);
    const byTier = sel.reduce((m, r) => { m[r.tier] = (m[r.tier] || 0) + 1; return m; }, {});
    console.log(`${apply ? "NOTICE" : "DRY RUN notice"}: ${sel.length} account(s) ${JSON.stringify(byTier)}, ${fmt(selPat)} PAT; apply on ${applyOn}, purge (tier A, still empty) from ${purgeOn}; ` +
                `${sel.filter((r) => r.f.login).length} with a Camfrog login (Pepe PMs them when he sees them)`);
    if (!apply) { console.log("\nDRY RUN - nothing written. Re-run with --apply to start the warning window."); process.exit(0); }
    const inbox = require(path.join(appDir, "inbox"));
    const runId = "notice-" + new Date(now).toISOString().slice(0, 10);
    const r = await stale.startNotice(sel, { runId, applyOn, purgeOn, now, tiers, addInbox: (id, n) => inbox.addSafe(id, n) });
    console.log(`warning window started (run ${runId}): ${r.added} account(s) newly pending; meta ${JSON.stringify(r.meta)}`);
    process.exit(0);
  }

  if (args.export) {
    const out = p.rows.filter((r) => r.tier !== "active").map((r) => ({ userId: r.f.userId, username: r.f.username, camfrog: r.f.login || null,
      tier: r.tier, balance: Math.floor(r.f.balance), email: r.f.email, verified: r.f.verified, actions: r.f.activeN,
      lastSeen: new Date(Math.max(r.f.created, r.f.lastActive, r.f.lastPresence, r.f.cfSeen)).toISOString().slice(0, 10), why: r.why }));
    fs.writeFileSync(path.resolve(String(args.export)), JSON.stringify(out, null, 1));
    console.log(`exported ${out.length} non-active account(s) to ${args.export} (no email addresses)`);
  }

  // a warning window is running: only accounts that were warned, are still pending, and still qualify
  // (read-only: the notice tables exist only once a run was started)
  let todo = sel;
  const meta = (await getQuery("SELECT 1 FROM sqlite_master WHERE name = 'stale_meta'")).length ? await stale.noticeMeta() : null;
  if (meta && meta.apply_on && !args["ignore-notice"]) {
    const pend = new Set((await getQuery("SELECT userId FROM stale_notice WHERE state = 'pending'")).map((x) => x.userId));
    todo = sel.filter((r) => pend.has(r.f.userId));
    console.log(`warning window ${meta.run_id} (archive on ${meta.apply_on}, purge from ${meta.purge_on}): ${todo.length} of ${sel.length} selected account(s) were warned and are still pending, ` +
                `${fmt(todo.reduce((t, r) => t + Math.max(0, Math.floor(r.f.balance)), 0))} PAT`);
    if (apply && now < Date.parse(meta.apply_on + "T00:00:00Z") && !args["force-early"]) {
      console.error(`the warning window runs until ${meta.apply_on} - not archiving before then (--force-early to override)`); process.exit(2);
    }
  }

  if (!apply) { console.log("\nDRY RUN - nothing written. Re-run with --apply to archive the selected tiers."); process.exit(0); }

  const b = await backup(args["backup-dir"]);
  console.log(`backup: ${b.file} (${fmt(b.size)} bytes)`);
  if (!(await stale.ensure())) throw new Error("could not add the archive column");
  const runId = "stale-" + new Date(now).toISOString().slice(0, 10) + "-" + Math.random().toString(36).slice(2, 8);
  const limit = Number(args.limit) || todo.length;
  let n = 0, pat = 0;
  for (const r of todo.slice(0, limit)) {
    const res = await stale.archiveOne(r.f.userId, { runId, tier: r.tier, why: r.why, graceDays: opts.graceDays, now });
    if (res) { n++; pat += res.reclaimed; }
  }
  console.log(`ARCHIVED ${n} account(s), ${fmt(pat)} PAT to the Federal Reserve (run ${runId}). Undo: node migrate-stale-accounts.js --rollback=${runId} --apply`);
  process.exit(0);
})().catch((e) => { console.error("failed:", e.stack || e.message); process.exit(1); });
