#!/usr/bin/env node
// tools/policy-backend.js — PO-0b (economy policy -> site plan, "Phase 6"): what the site knows about the economy policy
// hand-over, from the server's shell. READ-ONLY: it only SELECTs (no init(), no CREATE, no write) - safe on prod at any time.
// Run in the site directory (it opens ./myapp.db). Modelled on tools/fed-backend.js.
//   node tools/policy-backend.js [status]     # engines + modes, Pepe's policy push (age, bot_version, flags), recent runs,
//                                             # the backends' live switches, owner changes waiting, website claims
//   node tools/policy-backend.js preflight    # the site half of the hand-over preflight (plan §6.2): every check PASS / WARN /
//                                             # FAIL, exit code 1 on any FAIL. Pepe's half (his outboxes, unsure lists, dead
//                                             # letters, the last W record's notices / audit / digest) is `!econ policy status`.
// Later slices add `pause|resume` (PO-1) and the config checks (PO-2: every SPEC key present).
"use strict";
const path = require("path");
const { execFileSync } = require("child_process");
const { getQuery } = require(path.join(__dirname, "..", "dbUtils"));

const parse = (s, d = null) => { if (s == null) return d; try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
const ago = (ms) => { if (!ms) return "never"; const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 120 ? s + " s ago" : s < 7200 ? Math.round(s / 60) + " min ago" : s < 172800 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago"; };
let tables = null;
async function has(t) {
  if (!tables) tables = new Set((await getQuery("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name));
  return tables.has(t);
}
async function q(sql, params = [], table = null) {
  if (table && !(await has(table))) return [];
  return getQuery(sql, params);
}
async function meta(table, key) {
  const r = (await q(`SELECT value FROM ${table} WHERE key = ?`, [key], table))[0];
  return r ? parse(r.value, r.value) : null;
}
function siteVersion() {
  const git = (args) => { try { return execFileSync("git", args, { cwd: path.join(__dirname, ".."), timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch (e) { return ""; } };
  const sha = git(["rev-parse", "--short", "HEAD"]);
  const m = /^(\d+\.\d+[a-z]*)\b/.exec(git(["log", "-1", "--format=%s"]));
  return { sha: sha || null, version: m ? m[1] : null };
}

async function gather() {
  const out = { site: siteVersion(), staging: !!process.env.STAGING };
  out.engines = {};
  for (const e of ["treasury", "monetary", "burn"]) out.engines[e] = { mode: "off", armed_at: null, by: null, updated: null };
  for (const r of await q("SELECT engine, mode, armed_at, by, updated, note FROM policy_engines", [], "policy_engines")) out.engines[r.engine] = r;
  const push = await meta("policy_meta", "cfg");
  out.push = push ? { age_s: push.at ? Math.round(Date.now() / 1000 - Number(push.at)) : null, bot_version: push.bot_version || "",
                      flags: push.flags || {}, hour: (push.consts || {}).VAULT_EPOCH_UTC_HOUR } : null;
  out.runs = await q(`SELECT engine, period, state, via, error, created, done FROM policy_runs ORDER BY created DESC LIMIT 12`, [], "policy_runs");
  out.moving = await q("SELECT key, engine, period, created FROM policy_runs WHERE state = 'moving'", [], "policy_runs");
  out.failed7 = await q("SELECT key, engine, period, error, created FROM policy_runs WHERE state = 'failed' AND created >= ?", [Date.now() - 7 * 86400e3], "policy_runs");
  out.effectsOld = (await q("SELECT COUNT(*) AS n FROM policy_effects WHERE acked_at IS NULL AND created < ?", [Date.now() - 3600e3], "policy_effects"))[0] || { n: 0 };
  out.backends = {
    pools: { enabled: await meta("pools_meta", "enabled"), live: !!(await meta("pools_meta", "live")) },
    stashes: { enabled: await meta("stash_meta", "enabled"), live: !!(await meta("stash_meta", "imported")) },
    capital: { enabled: await meta("capital_meta", "enabled"), live: !!(await meta("capital_meta", "live")) },
    fed: { enabled: await meta("fed_meta", "enabled"), live: !!(await meta("fed_meta", "live")) },
    escrow: { enabled: await meta("escrow_meta", "enabled"), live: !!(await meta("escrow_meta", "live")) },
    gangs: { enabled: await meta("gangs_meta", "enabled"), live: !!(await meta("gangs_meta", "live")) },
  };
  out.owners = (await q("SELECT login FROM pepe_roles WHERE role = 'owner' ORDER BY login", [], "pepe_roles")).map((r) => r.login);
  out.rolesPending = await q("SELECT login, role, was, updated FROM pepe_roles_pending ORDER BY created", [], "pepe_roles_pending");
  const claims = await q(`SELECT CASE WHEN flow LIKE 'incentives:%' THEN 'incentives' WHEN flow LIKE 'flash:%' THEN 'flash' WHEN flow LIKE 'mint:%' THEN 'mint'
                                      WHEN flow LIKE 'room:%' THEN 'room' ELSE 'site' END AS kind, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS t,
                                 MIN(created) AS oldest
                          FROM reserve_claims WHERE settled = 0 AND COALESCE(queued, 0) = 0 GROUP BY kind ORDER BY kind`, [], "reserve_claims");
  out.claims = claims;
  out.turfInbox = (await q("SELECT COUNT(*) AS n FROM turf_inbox WHERE applied_at IS NULL", [], "turf_inbox"))[0] || { n: 0 };
  // the last weekly record Pepe pushed with his capital config (per-vault totals only)
  const ccfg = await meta("capital_meta", "cfg");
  const wf = ccfg && Array.isArray(ccfg.waterfall) ? ccfg.waterfall.slice().sort((a, b) => Number(a.boundary || 0) - Number(b.boundary || 0)) : [];
  out.lastW = wf.length ? wf[wf.length - 1] : null;
  return out;
}

function printStatus(s) {
  console.log(`site     ${s.site.version || "?"} (${s.site.sha || "no git"})${s.staging ? " STAGING" : ""}`);
  for (const [e, r] of Object.entries(s.engines)) {
    console.log(`engine   ${e.padEnd(9)} ${String(r.mode).padEnd(7)} armed ${r.armed_at ? new Date(Number(r.armed_at) * 1000).toISOString().slice(0, 16) : "-"}  by ${r.by || "-"} ${r.updated ? ago(r.updated) : ""}`);
  }
  if (!s.push) console.log("push     Pepe's policy push: never received");
  else console.log(`push     Pepe's policy push ${s.push.age_s == null ? "?" : s.push.age_s + " s"} old · bot_version ${s.push.bot_version || "(empty)"} · flags ${JSON.stringify(s.push.flags)} · epoch hour ${s.push.hour ?? "?"}`);
  for (const r of s.runs) console.log(`run      ${r.engine}:${r.period} ${r.state}${r.via ? " via " + r.via : ""}${r.error ? " - " + r.error : ""} (${ago(r.created)})`);
  for (const [k, v] of Object.entries(s.backends)) console.log(`backend  ${k.padEnd(8)} enabled=${v.enabled === null ? "default" : v.enabled} live=${v.live}`);
  console.log(`owners   ${s.owners.join(", ") || "(none)"}`);
  for (const p of s.rolesPending) console.log(`pending  owner change ${p.login}: ${p.was || "none"} -> ${p.role || "none"} (${ago(p.updated)}) - confirm on /admin/roles#pending`);
  for (const c of s.claims) console.log(`claims   ${c.kind.padEnd(10)} ${c.n} unsettled, ${c.t} PAT, oldest ${c.oldest || "-"}`);
  if (s.lastW) console.log(`last W   ${s.lastW.epoch} state=${s.lastW.state || "?"} done=${s.lastW.done ? new Date(Number(s.lastW.done) * 1000).toISOString().slice(0, 16) : "-"}`);
}

/** The site half of the plan §6.2 preflight. -> [{level: PASS|WARN|FAIL|INFO, check, detail}] */
function preflight(s) {
  const out = [];
  const add = (level, check, detail) => out.push({ level, check, detail });
  add(s.site.sha ? "PASS" : "WARN", "site version", `${s.site.version || "?"} (${s.site.sha || "no git checkout"})`);
  if (!s.push) add("FAIL", "Pepe's policy push", "never received (/api/policy/bot/config)");
  else {
    add(s.push.age_s != null && s.push.age_s < 1800 ? "PASS" : "FAIL", "Pepe's policy push is fresh", `${s.push.age_s == null ? "?" : s.push.age_s + " s"} old (< 30 min)`);
    add(s.push.bot_version ? "PASS" : "FAIL", "bot_version in the push", s.push.bot_version || "empty - Pepe sends it from PO-0c (pepe_policyclient._p4_cfg)");
  }
  add(s.moving.length ? "FAIL" : "PASS", "no policy run in 'moving'", s.moving.map((r) => r.key).join(", ") || "none");
  add(s.failed7.length ? "WARN" : "PASS", "no failed policy run in 7 days", s.failed7.map((r) => `${r.key}: ${r.error || "?"}`).join("; ") || "none");
  add(Number(s.effectsOld.n) ? "WARN" : "PASS", "policy effects acked by Pepe", `${Number(s.effectsOld.n)} older than 1 h not acked`);
  add(s.owners.length ? "PASS" : "FAIL", "Pepe has an owner on the site", s.owners.join(", ") || "none");
  add(s.rolesPending.length ? "FAIL" : "PASS", "no owner change waiting", s.rolesPending.map((p) => `${p.login} -> ${p.role || "none"}`).join(", ") || "none");
  add(Number(s.turfInbox.n) ? "WARN" : "PASS", "pools turf inbox drained", `${Number(s.turfInbox.n)} leg(s) not applied by Pepe`);
  const old = s.claims.filter((c) => c.oldest && Date.now() - Date.parse(String(c.oldest).replace(" ", "T") + (String(c.oldest).endsWith("Z") ? "" : "Z")) > 86400e3);
  add(old.length ? "WARN" : "PASS", "no website claim unsettled for a day", old.map((c) => `${c.kind}: ${c.n} (${c.t} PAT)`).join(", ") || "none");
  for (const k of ["pools", "stashes", "capital"]) add(s.backends[k].live ? "PASS" : "FAIL", `${k} live on the site`, s.backends[k].live ? "yes" : "no - the policy hand-over moves after the money");
  for (const k of ["fed", "escrow", "gangs"]) add("INFO", `${k} live on the site`, String(s.backends[k].live));
  for (const e of ["treasury", "monetary", "burn"]) add("INFO", `engine ${e}`, s.engines[e].mode);
  add("INFO", "last W record", s.lastW ? `${s.lastW.epoch} ${s.lastW.state || "?"} (notified / audit / digest_sent: Pepe's half)` : "none pushed");
  add("INFO", "Pepe's half", "!econ policy status: pvault unsure/outbox, corrections unsure/paying, pools outbox/uncertain/inbox, policy outbox + dead letters, capital outbox, the last W record");
  add("INFO", "config keys", "every SPEC key present - checked from PO-2 (policy_cfg)");
  return out;
}

async function main() {
  const [cmd = "status"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!["status", "preflight"].includes(cmd)) throw new Error("usage: node tools/policy-backend.js [status|preflight]   (read-only)");
  const s = await gather();
  if (process.argv.includes("--json")) { console.log(JSON.stringify(cmd === "preflight" ? preflight(s) : s, null, 2)); process.exit(0); }
  if (cmd === "status") { printStatus(s); process.exit(0); }
  const res = preflight(s);
  for (const r of res) console.log(`${r.level.padEnd(4)}  ${r.check}: ${r.detail}`);
  const fails = res.filter((r) => r.level === "FAIL").length;
  console.log(fails ? `\npreflight: ${fails} FAIL - not ready` : "\npreflight: the site's half is ready (now Pepe's: !econ policy status)");
  process.exit(fails ? 1 : 0);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { gather, preflight };
