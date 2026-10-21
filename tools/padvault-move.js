#!/usr/bin/env node
// tools/padvault-move.js — 1.99yx: an ops run of a pad vault FINE or TRANSFER (padfines.js -> Pepe's pepe_padfine.py), the same
// request the /pads/admin card sends, for a move the user approved in chat (first use: 10M DRAMA_CENTRAL -> Pepe's Pad,
// 2026-10-14). Run in the site directory (it opens ./myapp.db).
//
//   node tools/padvault-move.js --from DRAMA_CENTRAL --to PepeFrog.Room --amount 10000000 --reason "..." --admin pb
//        DRY RUN (read-only SELECTs): both vaults' balances, the cap, the fine route, the admin account, the pools switch
//   ... --apply
//        1. a verified backup of the database (dbbackup.backupDb, ./backups/myapp-pre-padvault-move-<ts>.db)
//        2. padfines.request(admin, ...): ONE website action "roomvault.admin" for Pepe + the pad_vault_admin_moves row +
//           the admin_audit row (as --admin, a site Admin). Pepe runs it with his own checks (the whole amount or nothing,
//           the other vault's cap); the move itself is his (keyed pool legs - supply unchanged)
//        3. waits up to --wait seconds (default 180) for Pepe's answer and prints it with the balances after
//   --op fine           a fine instead (no --to): PAT Routing row fine_pad (default the Federal Reserve)
//   --key <8-64 chars>  the request key (a re-run with the same key never queues twice); default a fixed key per
//                       from/to/amount so an accidental second --apply is a no-op
"use strict";
const path = require("path");
const crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
process.chdir(ROOT);
const { getQuery } = require(path.join(ROOT, "dbUtils"));

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CAP = 50000000;

async function bal(room) {
  const r = (await getQuery("SELECT balance FROM pools WHERE key = ?", ["room:" + room]).catch(() => []))[0];
  return r ? Number(r.balance) : 0;
}

(async () => {
  const from = arg("from"), to = arg("to"), adminName = arg("admin");
  const op = arg("op", to ? "transfer" : "fine");
  const amount = parseInt(String(arg("amount", "")).replace(/[,_]/g, ""), 10);
  const reason = String(arg("reason", "") || "").trim();
  if (!from || !adminName || !Number.isFinite(amount) || amount < 1 || reason.length < 3 || (op === "transfer" && !to)) {
    console.error("usage: node tools/padvault-move.js --from <pad id> [--to <pad id>] --amount <PAT> --reason \"...\" --admin <site admin username> [--op fine] [--apply]");
    process.exit(2);
  }
  const pools = Object.fromEntries((await getQuery("SELECT key, value FROM pools_meta").catch(() => [])).map((r) => [r.key, r.value]));
  const pads = await getQuery("SELECT room_id, title, owner_kind, owner_user_id FROM rooms_registry WHERE room_id IN (?, ?)", [from, to || from]);
  const P = (id) => pads.find((p) => p.room_id === id);
  const adm = (await getQuery("SELECT userId, username, class FROM users WHERE LOWER(username) = LOWER(?)", [adminName]))[0];
  // the route as the site reads it (padfines.fineRoute: the policy config store once the site owns the economy settings -
  // never the frozen pre-H1 table; unreadable -> unknown, not the default)
  const route = await require(path.join(ROOT, "padfines")).fineRoute();
  const before = { from: await bal(from), to: to ? await bal(to) : null };
  const key = arg("key") || ("ops-" + crypto.createHash("sha256").update(`${op}|${from}|${to || ""}|${amount}`).digest("hex").slice(0, 20));
  const report = {
    db: path.resolve("myapp.db"), pools_live: pools.live === "true", op, key,
    from: { id: from, pad: P(from) || null, vault: before.from }, to: to ? { id: to, pad: P(to) || null, vault: before.to } : null,
    amount, reason, admin: adm ? { username: adm.username, class: adm.class } : null,
    fine_route: op === "fine" ? (route.unavailable ? "unknown (the economy settings can't be read)" : route.shares) : undefined,
  };
  const problems = [];
  if (!report.pools_live) problems.push("the pools are not live on this site (Pepe moves them locally - run !padmove in chat instead)");
  if (!P(from)) problems.push(`no pad ${from}`);
  if (to && !P(to)) problems.push(`no pad ${to}`);
  if (before.from < amount) problems.push(`the ${from} vault holds only ${fmt(before.from)}`);
  if (op === "transfer" && before.to + amount > CAP) problems.push(`${to} would pass the ${fmt(CAP)} cap (Pepe's econ_cfg may differ)`);
  if (!adm || adm.class !== "Admin") problems.push(`--admin ${adminName} is not a site Admin`);
  const have = (await getQuery("SELECT status, action_id FROM pad_vault_admin_moves WHERE key = ?", ["web-" + key]).catch(() => []))[0];
  if (have) report.already = have;
  console.log(JSON.stringify(report, null, 2));
  if (problems.length) { console.error("REFUSED:\n - " + problems.join("\n - ")); process.exit(1); }
  if (!flag("apply")) { console.log(`DRY RUN: would ${op} ${fmt(amount)} PAT ${from}${to ? " -> " + to : ""}. Add --apply to send it to Pepe.`); process.exit(0); }

  const file = await require(path.join(ROOT, "dbbackup")).backupDb("pre-padvault-move");
  console.log("backup:", file);
  const r = await require(path.join(ROOT, "padfines")).request({ userId: adm.userId, username: adm.username }, { op, from, to, amount, reason, key });
  console.log("queued:", JSON.stringify(r));
  const wait = Math.max(10, parseInt(arg("wait", "180"), 10) || 180) * 1000;
  const t0 = Date.now();
  let a = null;
  while (Date.now() - t0 < wait) {
    a = (await getQuery("SELECT status, message FROM pepe_actions WHERE id = ?", [r.id]))[0];
    if (a && a.status !== "pending" && a.status !== "claimed") break;
    await sleep(3000);
  }
  console.log("Pepe:", JSON.stringify(a));
  await sleep(5000);
  console.log("after:", JSON.stringify({ from: await bal(from), to: to ? await bal(to) : null,
    row: (await getQuery("SELECT status, done_at FROM pad_vault_admin_moves WHERE key = ?", [r.key]))[0] || null }));
  process.exit(a && a.status === "done" ? 0 : 3);
})().catch((e) => { console.error(e); process.exit(1); });
