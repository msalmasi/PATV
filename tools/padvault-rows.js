#!/usr/bin/env node
// tools/padvault-rows.js — 1.99uu: EVERY PAD HAS A VAULT (the user, 2026-10-12: "earning does not need Plus"). Before, only
// pads with a connected Camfrog room had one (roomvaults.hasVault / boosts.vaultEligible / Pepe's _rv_eligible); now every
// registered pad does (connected or not), a profile pad while profile vaults are on.
//
// Nothing has to move for that: a vault is a pool in Pepe (room:<pad id>) that exists once something is credited, and the
// site's room_vault_state row appears with Pepe's first sync that lists the pad (card() answers 0 until then). This tool is
// the optional, IDEMPOTENT backfill of the empty site rows, plus the report the prod rollout needs. Run in the site directory
// (it opens ./myapp.db).
//
//   node tools/padvault-rows.js              DRY RUN (read-only: SELECTs only, no module init, safe on prod):
//                                            the pads by platform, which ones gain a vault, the rows a backfill would add,
//                                            the room-half escrow still held for newly eligible pads (it would now migrate
//                                            to their vault instead of Fort Knox - `!econ roomvaults migrate` previews it),
//                                            and the supply check (the new rows are empty: +0 PAT)
//   node tools/padvault-rows.js --apply      STAGING: INSERT OR IGNORE an empty row (balance 0) for every pad that has none,
//                                            in one dbUtils.tx. Refused outside staging unless --prod-ok (not for agents).
//   --json                                   the report as JSON
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { getQuery, runQuery, tx } = require(path.join(ROOT, "dbUtils"));

const flag = (k) => process.argv.includes(`--${k}`);
const PLATFORM = (id, p) => {
  if (p) return String(p).toLowerCase();
  const m = /^(patv|twitch|discord|user):/i.exec(String(id || ""));
  return !m ? "camfrog" : m[1].toLowerCase() === "patv" ? "site" : m[1].toLowerCase() === "user" ? "profile" : m[1].toLowerCase();
};
const safe = async (sql, args) => { try { return await getQuery(sql, args || []); } catch (e) { return null; } };

async function report() {
  const pads = (await safe("SELECT room_id, platform FROM rooms_registry")) || [];
  const rowsQ = await safe("SELECT room_id, balance FROM room_vault_state");
  const have = new Map((rowsQ || []).map((r) => [r.room_id, Number(r.balance) || 0]));
  const meta = new Map(((await safe("SELECT key, value FROM room_vault_meta")) || []).map((r) => [r.key, r.value]));
  const profileOn = meta.get("profile_vaults") === "true";
  const esc = new Map(((await safe(`SELECT room_id, COALESCE(SUM(room_vault), 0) AS held FROM room_flow_ledger
                                    WHERE migrated_rv IS NULL AND rv_to IS NULL GROUP BY room_id`)) || []).map((r) => [r.room_id, Number(r.held) || 0]));
  const by = {};
  const add = [], gained = [];
  for (const p of pads) {
    const plat = PLATFORM(p.room_id, p.platform);
    const b = (by[plat] = by[plat] || { pads: 0, had_vault_before: 0, has_vault_now: 0, rows_present: 0, rows_to_add: 0 });
    b.pads += 1;
    const before = plat === "camfrog" || (plat === "profile" && profileOn);
    const now = plat !== "profile" || profileOn;
    if (before) b.had_vault_before += 1;
    if (now) b.has_vault_now += 1;
    if (have.has(p.room_id)) b.rows_present += 1;
    // profiles get their rows from Pepe's sync (only while profile vaults are on); the backfill covers the other pads
    if (now && plat !== "profile" && !have.has(p.room_id)) { b.rows_to_add += 1; add.push(p.room_id); }
    if (now && !before) gained.push({ room_id: p.room_id, platform: plat, escrow_held: esc.get(p.room_id) || 0, balance: have.get(p.room_id) || 0 });
  }
  const balBefore = [...have.values()].reduce((s, v) => s + v, 0);
  return {
    db: path.resolve("myapp.db"), staging: !!process.env.STAGING, vaults_live: meta.get("on") === "true", profile_vaults: profileOn,
    platforms: by, gained: gained.length, gained_with_escrow: gained.filter((g) => g.escrow_held !== 0),
    escrow_held_for_gained: gained.reduce((s, g) => s + g.escrow_held, 0),
    rows_to_add: add.length, rows: add,
    supply: { site_vault_rows_sum_before: balBefore, site_vault_rows_sum_after: balBefore, delta: 0,
              note: "new rows are empty (balance 0); Pepe's pools are untouched (a vault exists once something is credited)" },
  };
}

(async () => {
  const r = await report();
  if (flag("apply")) {
    if (!process.env.STAGING && !flag("prod-ok")) throw new Error("--apply is for staging (STAGING=1); prod: dry run only");
    const t = Date.now();
    let n = 0;
    await tx(async () => {
      for (const id of r.rows) {
        const res = await runQuery(`INSERT OR IGNORE INTO room_vault_state (room_id, balance, days, history, updated) VALUES (?, 0, '{}', '[]', ?)`, [id, t]);
        n += Number((res && res.changes) || 0);
      }
    });
    r.applied = n;
  }
  if (flag("json")) { console.log(JSON.stringify(r, null, 1)); }
  else {
    console.log(`${r.applied === undefined ? "DRY RUN" : "APPLIED"} on ${r.db}${r.staging ? " (staging)" : ""} - pad vaults ${r.vaults_live ? "live" : "not live"}, profile vaults ${r.profile_vaults ? "on" : "off"}`);
    for (const [k, b] of Object.entries(r.platforms)) {
      console.log(`  ${k.padEnd(8)} ${String(b.pads).padStart(5)} pads: vault before ${b.had_vault_before}, now ${b.has_vault_now}; site rows ${b.rows_present}, to add ${b.rows_to_add}`);
    }
    console.log(`  ${r.gained} pad(s) gain a vault; site escrow still held for them: ${r.escrow_held_for_gained.toLocaleString("en-US")} PAT` +
                (r.gained_with_escrow.length ? ` (${r.gained_with_escrow.map((g) => `${g.room_id} ${g.escrow_held}`).join(", ")})` : ""));
    console.log(`  rows to add: ${r.rows_to_add}${r.applied !== undefined ? `, inserted ${r.applied}` : ""}; supply delta ${r.supply.delta} PAT`);
  }
  process.exit(0);
})().catch((e) => { console.error("padvault-rows:", e.message); process.exit(1); });
