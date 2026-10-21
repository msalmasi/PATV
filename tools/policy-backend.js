#!/usr/bin/env node
// tools/policy-backend.js — PO-0b (economy policy -> site plan, "Phase 6"): what the site knows about the economy policy
// hand-over, from the server's shell. status / preflight are READ-ONLY: they only SELECT (no init(), no CREATE, no write) -
// safe on prod at any time. Run in the site directory (it opens ./myapp.db). Modelled on tools/fed-backend.js.
//   node tools/policy-backend.js [status]     # engines + modes (+ paused), Pepe's policy push (age, bot_version, flags), recent
//                                             # runs, missed periods, the shadow comparisons (clean / boundary), the backends'
//                                             # live switches, owner changes waiting, website claims, closed stashes with no
//                                             # account to pay + waterfall stash legs refused lately
//   node tools/policy-backend.js preflight [--since=YYYY-MM-DD]   # the site half of the hand-over preflight (plan §6.2): every check PASS / WARN /
//                                             # FAIL, exit code 1 on any FAIL. Pepe's half (his outboxes, unsure lists, dead
//                                             # letters, the last W record's notices / audit / digest) is `!econ policy status`.
//   node tools/policy-backend.js --actor=<who> pause <treasury|monetary|burn|all> --note "why"
//   node tools/policy-backend.js --actor=<who> resume <treasury|monetary|burn|all> [--note "..."]
//                                             # PO-1 (T3): the owner's kill switch from the shell - no role sync, no Pepe needed.
//                                             # ONE dbUtils.tx (the flag + policy_audit + admin_audit "cli:<who>"), then every
//                                             # site admin is told (opsalerts). A paused engine runs nothing (a live one's due
//                                             # periods are recorded missed); resume lets only the current period run (late, D-18).
//                                             # WRITES - on prod only with the owner's explicit go.
//   node tools/policy-backend.js --actor=<who> pause|resume <cfg|budget|staking_ops|loans_desk|features> --note "why"
//                                             # PO-2: the same for a FEATURE (policy_ownership.paused): a paused cfg refuses every
//                                             # edit of the economy settings (423); the readers keep reading.
//   --dir=<folder with myapp.db>              # run against that folder's database (default: the current directory)
// PO-1 review: it never opens a database that isn't there - with no ./myapp.db (the wrong directory) every command stops
// (exit 2) instead of creating an empty one, and pause / resume also refuse a database without the site's users and
// policy_engines tables: the kill switch must never report PAUSED while prod keeps running.
// PO-2: the config store - who owns each feature (pepe / cutting / site, paused, being handed back), the rev, every SPEC key present
// (FAIL if not), the mirror's daily diff counts (policy_meta cfg_mirror_days) and the dual read's last 7 days (policy_cfg_dualcheck /
// _dualread).
// Review of PO-2: the H1 evidence gates FAIL without evidence - `preflight [--since=YYYY-MM-DD]` checks every complete UTC day from
// --since (default: the last 4) to yesterday: the mirror diff CHECKED and empty that day (gate 1), and the dual read RECORDED for
// every daily reader that day - capital.cutoff (capital live), policy.source (an engine on), funding.monetary (Pepe pushing) - with
// no difference (gate 2). A difference today fails too. For H1: --since=2026-10-30.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
// dbUtils opens ./myapp.db (creating it) the moment it loads: loaded only after main() checked the directory
const getQuery = (sql, params) => require(path.join(__dirname, "..", "dbUtils")).getQuery(sql, params);

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
// The i18n bot's commits ("i18n: translate new strings for <sha> [skip ci]") land on top of every release on staging / main: the
// version is the newest commit subject that ISN'T one of them (its own release letter, e.g. "1.99adu site: ..."), never "?" because
// the translations came last.
const I18N_SUBJECT = /^i18n:/i;
/** The release letter of the newest non-i18n commit subject among `subjects` (newest first: [{sha, subject}]). */
function versionOf(subjects) {
  const top = (subjects || []).find((s) => s && !I18N_SUBJECT.test(String(s.subject || "").trim()));
  if (!top) return { version: null, version_sha: null, subject: null };
  const m = /^(\d+\.\d+[a-z]*)\b/.exec(String(top.subject).trim());
  return { version: m ? m[1] : null, version_sha: top.sha || null, subject: String(top.subject).slice(0, 120) };
}
function siteVersion() {
  const git = (args) => { try { return execFileSync("git", args, { cwd: path.join(__dirname, ".."), timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch (e) { return ""; } };
  const sha = git(["rev-parse", "--short", "HEAD"]);
  const subjects = git(["log", "-n", "40", "--format=%h%x09%s"]).split("\n").filter(Boolean).map((l) => {
    const i = l.indexOf("\t");
    return { sha: i < 0 ? l : l.slice(0, i), subject: i < 0 ? "" : l.slice(i + 1) };
  });
  return Object.assign({ sha: sha || null }, versionOf(subjects));
}

/** Does a stash owner key (a login, or "u:<userId>") have a PATV account to pay? stashes.holderInfo's rule, in SELECTs only:
 *  an account key follows merges (account_merges, then account_merge_log - usernames.resolveUserId); a login needs exactly
 *  one linked account. */
async function ownerHasAccount(owner) {
  const k = String(owner || "").trim();
  const m = /^u:([A-Za-z0-9_-]{1,64})$/.exec(k);
  if (!m) {
    if (!k || !(await has("users"))) return false;
    return (await getQuery("SELECT userId FROM users WHERE lower(trim(camfrogUsername)) = ? LIMIT 2", [k.toLowerCase()])).length === 1;
  }
  let cur = m[1];
  for (let hop = 0; hop < 8; hop++) {
    if ((await q("SELECT 1 FROM users WHERE userId = ?", [cur], "users")).length) return true;
    let next = ((await q("SELECT new_id FROM account_merges WHERE old_id = ?", [cur], "account_merges"))[0] || {}).new_id || null;
    if (!next) next = ((await q("SELECT to_id FROM account_merge_log WHERE from_id = ? ORDER BY at DESC LIMIT 1", [cur], "account_merge_log"))[0] || {}).to_id || null;
    if (!next || next === cur) return false;
    cur = next;
  }
  return false;
}

const DAY_MS = 86400e3;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
/** The complete UTC days the evidence gates read: --since (YYYY-MM-DD) .. yesterday; by default the last 4. */
function evidenceDays(since, now = Date.now()) {
  const today = utcDay(now);
  let from = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : utcDay(now - 4 * DAY_MS);
  if (from > today) from = today;
  const days = [];
  for (let t = Date.parse(from + "T00:00:00Z"); utcDay(t) < today && days.length < 60; t += DAY_MS) days.push(utcDay(t));
  return { from, today, days };
}

async function gather(opts = {}) {
  const out = { site: siteVersion(), staging: !!process.env.STAGING };
  out.engines = {};
  for (const e of ["treasury", "monetary", "burn"]) out.engines[e] = { mode: "off", armed_at: null, by: null, updated: null, paused: 0 };
  // PO-1: the pause columns exist once a PO-1 site started (core.init adds them) - read them only then
  const pcols = (await has("policy_engines")) ? new Set((await getQuery("PRAGMA table_info(policy_engines)")).map((c) => c.name)) : new Set();
  const psel = pcols.has("paused") ? ", paused, paused_by, paused_at, pause_note" : "";
  for (const r of await q(`SELECT engine, mode, armed_at, by, updated, note${psel} FROM policy_engines`, [], "policy_engines")) out.engines[r.engine] = r;
  out.missed7 = await q("SELECT key, engine, period, error, created FROM policy_runs WHERE state = 'missed' AND created >= ? ORDER BY created", [Date.now() - 7 * 86400e3], "policy_runs");
  // the shadow comparisons of the last 14 days: clean (ok = 1), compared against a boundary snapshot (PO-1) or not
  const scols = (await has("policy_sims")) ? new Set((await getQuery("PRAGMA table_info(policy_sims)")).map((c) => c.name)) : new Set();
  out.shadow14 = await q(`SELECT key, engine, period, ok, ${scols.has("boundary_ts") ? "boundary_ts" : "NULL AS boundary_ts"}, pepe_plan IS NOT NULL AS reported, updated
                          FROM policy_sims WHERE mode = 'shadow' AND updated >= ? ORDER BY updated`, [Date.now() - 14 * 86400e3], "policy_sims");
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
  // PO-0b (a) + its review: a credit that reaches a CLOSED stash is paid to its owner's wallet; with no PATV account to pay it
  // is refused (409 E_STASH_CLOSED, recorded under its key). Until PO-0c, Pepe's _tr_finish resends a refused waterfall
  // stash leg every tick (the week's record never finishes) - so: which closed stashes can't be paid, and which waterfall
  // legs were refused lately
  out.closedNoAccount = [];
  for (const s of await q("SELECT id, name, owner FROM stashes WHERE closed IS NOT NULL ORDER BY id", [], "stashes")) {
    if (!(await ownerHasAccount(s.owner))) out.closedNoAccount.push({ id: s.id, name: s.name, owner: s.owner });
  }
  out.refusedWf = await q("SELECT key, stash_id, ts, result FROM stash_moves WHERE kind = 'refused' AND key LIKE 'wf-%' AND ts >= ? ORDER BY ts",
                          [Date.now() - 14 * 86400e3], "stash_moves");
  // the last weekly record Pepe pushed with his capital config (per-vault totals only)
  const ccfg = await meta("capital_meta", "cfg");
  const wf = ccfg && Array.isArray(ccfg.waterfall) ? ccfg.waterfall.slice().sort((a, b) => Number(a.boundary || 0) - Number(b.boundary || 0)) : [];
  out.lastW = wf.length ? wf[wf.length - 1] : null;
  // PO-2: the policy config store (cfgspec is a pure module - no database)
  const SPEC = require(path.join(__dirname, "..", "policy", "cfgspec"));
  out.features = {};
  for (const f of ["cfg", "budget", "staking_ops", "loans_desk"]) out.features[f] = { owner: "pepe", paused: 0 };
  const ocols = (await has("policy_ownership")) ? new Set((await getQuery("PRAGMA table_info(policy_ownership)")).map((c) => c.name)) : new Set();
  const osel = ocols.has("return_sha") ? ", return_sha, return_at" : "";
  for (const r of await q(`SELECT feature, owner, paused, paused_by, paused_at, note, since, handover_key${osel} FROM policy_ownership`, [], "policy_ownership")) out.features[r.feature] = r;
  const rev = (await q("SELECT rev, sha, updated FROM policy_cfg_rev WHERE id = 1", [], "policy_cfg_rev"))[0] || null;
  const have = new Set((await q("SELECT key FROM policy_cfg", [], "policy_cfg")).map((r) => r.key));
  out.cfg = { rev: rev ? rev.rev : null, sha: rev ? rev.sha : null, updated: rev ? rev.updated : null, keys: have.size, store: await has("policy_cfg"),
              missing: SPEC.KEYS.filter((k) => !have.has(k)) };
  const days = (await meta("policy_meta", "cfg_mirror_days")) || {};
  out.mirrorDays = Object.keys(days).sort().slice(-7).map((d) => Object.assign({ day: d }, days[d]));
  const since = new Date(Date.now() - 6 * 86400e3).toISOString().slice(0, 10);
  out.dualChecks = await q("SELECT day, consumer, checks, diffs FROM policy_cfg_dualcheck WHERE day >= ? ORDER BY day, consumer", [since], "policy_cfg_dualcheck");
  out.dualDiffs = await q("SELECT day, consumer, key, push, site, n FROM policy_cfg_dualread WHERE day >= ? ORDER BY last_ts DESC LIMIT 20", [since], "policy_cfg_dualread");
  // review of PO-2: the evidence window (every day in it must carry its evidence)
  const ev = evidenceDays(opts.since);
  out.evidence = { from: ev.from, today: ev.today, days: ev.days,
                   mirror: Object.fromEntries([...ev.days, ev.today].map((d) => [d, days[d] || null])),
                   dual: await q("SELECT day, consumer, checks, diffs FROM policy_cfg_dualcheck WHERE day >= ? ORDER BY day, consumer", [ev.from], "policy_cfg_dualcheck") };
  return out;
}

function printStatus(s) {
  const vAt = s.site.version_sha && s.site.version_sha !== s.site.sha ? ` at ${s.site.version_sha}` : "";
  console.log(`site     ${s.site.version || "?"}${vAt} (${s.site.sha || "no git"})${s.staging ? " STAGING" : ""}`);
  for (const [e, r] of Object.entries(s.engines)) {
    console.log(`engine   ${e.padEnd(9)} ${String(r.mode).padEnd(7)} armed ${r.armed_at ? new Date(Number(r.armed_at) * 1000).toISOString().slice(0, 16) : "-"}  by ${r.by || "-"} ${r.updated ? ago(r.updated) : ""}` +
                (Number(r.paused) ? `  PAUSED by ${r.paused_by || "?"} ${ago(r.paused_at)}${r.pause_note ? " (" + r.pause_note + ")" : ""}` : ""));
  }
  for (const m of s.missed7) console.log(`missed   ${m.engine}:${m.period} (${ago(m.created)}) - ${m.error || "?"}`);
  const rep = s.shadow14.filter((x) => Number(x.reported));
  if (rep.length) {
    const bad = rep.filter((x) => !Number(x.ok));
    console.log(`shadow   ${rep.length} period(s) compared in 14 days: ${rep.length - bad.length} clean, ${bad.length} not` +
                (bad.length ? ` (${bad.slice(-8).map((x) => `${x.engine}:${x.period}${x.boundary_ts == null ? " no boundary" : ""}`).join(", ")})` : ""));
  }
  if (!s.push) console.log("push     Pepe's policy push: never received");
  else console.log(`push     Pepe's policy push ${s.push.age_s == null ? "?" : s.push.age_s + " s"} old · bot_version ${s.push.bot_version || "(empty)"} · flags ${JSON.stringify(s.push.flags)} · epoch hour ${s.push.hour ?? "?"}`);
  for (const r of s.runs) console.log(`run      ${r.engine}:${r.period} ${r.state}${r.via ? " via " + r.via : ""}${r.error ? " - " + r.error : ""} (${ago(r.created)})`);
  for (const [k, v] of Object.entries(s.backends)) console.log(`backend  ${k.padEnd(8)} enabled=${v.enabled === null ? "default" : v.enabled} live=${v.live}`);
  console.log(`owners   ${s.owners.join(", ") || "(none)"}`);
  for (const p of s.rolesPending) console.log(`pending  owner change ${p.login}: ${p.was || "none"} -> ${p.role || "none"} (${ago(p.updated)}) - confirm on /admin/roles#pending`);
  for (const c of s.claims) console.log(`claims   ${c.kind.padEnd(10)} ${c.n} unsettled, ${c.t} PAT, oldest ${c.oldest || "-"}`);
  if (s.lastW) console.log(`last W   ${s.lastW.epoch} state=${s.lastW.state || "?"} done=${s.lastW.done ? new Date(Number(s.lastW.done) * 1000).toISOString().slice(0, 16) : "-"}`);
  console.log(`stashes  ${s.closedNoAccount.length} closed stash(es) with no account to pay${s.closedNoAccount.length ? ": " + s.closedNoAccount.map((x) => `${x.id} (${x.owner})`).join(", ") : ""}`);
  for (const r of s.refusedWf) console.log(`refused  ${r.key} (stash ${r.stash_id || "?"}, ${ago(r.ts)}): ${(parse(r.result, {}) || {}).code || (parse(r.result, {}) || {}).error || "?"}`);
  for (const [f, r] of Object.entries(s.features)) {
    console.log(`feature  ${f.padEnd(11)} ${String(r.owner).padEnd(7)}${r.since ? " since " + ago(r.since) : ""}${r.handover_key ? " (hand-over " + String(r.handover_key).slice(0, 12) + ")" : ""}` +
                (r.return_sha ? `  BEING HANDED BACK (sha ${String(r.return_sha).slice(0, 12)}, ${ago(r.return_at)}) - edits refused until Pepe confirms` : "") +
                (Number(r.paused) ? `  PAUSED by ${r.paused_by || "?"} ${ago(r.paused_at)}${r.note ? " (" + r.note + ")" : ""}` : ""));
  }
  if (!s.cfg.store) console.log("config   the policy config store isn't there yet (a site before PO-2)");
  else console.log(`config   rev ${s.cfg.rev ?? 0} · ${s.cfg.keys} key(s) · ${s.cfg.missing.length ? "MISSING " + s.cfg.missing.length + ": " + s.cfg.missing.slice(0, 10).join(", ") : "every SPEC key present"} · changed ${ago(s.cfg.updated)}`);
  for (const d of s.mirrorDays) console.log(`mirror   ${d.day} ${d.pushes} push(es), ${d.changes} change(s), diff ${d.max ? JSON.stringify(d.max) : "not checked"}`);
  for (const c of s.dualChecks) console.log(`dual     ${c.day} ${c.consumer.padEnd(16)} ${c.checks} check(s), ${c.diffs} difference(s)`);
  for (const x of s.dualDiffs.slice(0, 8)) console.log(`dualdiff ${x.day} ${x.consumer} ${x.key}: push ${x.push} / site ${x.site} (x${x.n})`);
}

/** The site half of the plan §6.2 preflight. -> [{level: PASS|WARN|FAIL|INFO, check, detail}] */
function preflight(s) {
  const out = [];
  const add = (level, check, detail) => out.push({ level, check, detail });
  add(s.site.sha ? "PASS" : "WARN", "site version", `${s.site.version || "?"}${s.site.version_sha && s.site.version_sha !== s.site.sha ? ` (release ${s.site.version_sha}, head ${s.site.sha})` : ` (${s.site.sha || "no git checkout"})`}`);
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
  // PO-0b's review: until PO-0c, a refused waterfall stash leg is resent by Pepe every tick (his week never finishes)
  add(s.refusedWf.length ? "WARN" : "PASS", "no waterfall stash leg refused in 14 days",
      s.refusedWf.map((r) => `${r.key} (${(parse(r.result, {}) || {}).code || "?"})`).join(", ") || "none");
  add(s.closedNoAccount.length ? "WARN" : "PASS", "every closed stash has an account to pay",
      s.closedNoAccount.length ? `${s.closedNoAccount.length}: ${s.closedNoAccount.slice(0, 12).map((x) => `${x.id} (${x.owner})`).join(", ")} - a credit to one is refused (409)` : "yes");
  for (const k of ["fed", "escrow", "gangs"]) add("INFO", `${k} live on the site`, String(s.backends[k].live));
  for (const e of ["treasury", "monetary", "burn"]) add("INFO", `engine ${e}`, s.engines[e].mode);
  // PO-1: a paused engine is refused at the cutover; a missed period (D-18) and an unclean shadow period need reading first
  const paused = Object.entries(s.engines).filter(([, r]) => Number(r.paused));
  add(paused.length ? "FAIL" : "PASS", "no policy engine paused", paused.map(([e, r]) => `${e} by ${r.paused_by || "?"}${r.pause_note ? " (" + r.pause_note + ")" : ""}`).join(", ") || "none");
  add(s.missed7.length ? "WARN" : "PASS", "no policy period missed in 7 days", s.missed7.map((m) => `${m.engine}:${m.period}`).join(", ") || "none");
  const unclean = s.shadow14.filter((x) => Number(x.reported) && !Number(x.ok));
  add(unclean.length ? "WARN" : "PASS", "shadow periods clean (14 days, D-15)",
      unclean.length ? unclean.slice(-12).map((x) => `${x.engine}:${x.period}${x.boundary_ts == null ? " (no boundary snapshot)" : ""}`).join(", ")
                     : `${s.shadow14.filter((x) => Number(x.reported)).length} compared, all clean`);
  add("INFO", "last W record", s.lastW ? `${s.lastW.epoch} ${s.lastW.state || "?"} (notified / audit / digest_sent: Pepe's half)` : "none pushed");
  add("INFO", "Pepe's half", "!econ policy status: pvault unsure/outbox, corrections unsure/paying, pools outbox/uncertain/inbox, policy outbox + dead letters, capital outbox, the last W record");
  // PO-2: the config store
  if (!s.cfg.store) add("FAIL", "config store", "policy_cfg isn't there - a site before PO-2");
  else add(s.cfg.missing.length ? "FAIL" : "PASS", "every config key present (policy_cfg)", s.cfg.missing.length ? `${s.cfg.missing.length} missing: ${s.cfg.missing.join(", ")}` : `${s.cfg.keys} keys, rev ${s.cfg.rev}`);
  const pausedF = Object.entries(s.features).filter(([, r]) => Number(r.paused));
  add(pausedF.length ? "FAIL" : "PASS", "no feature paused", pausedF.map(([f, r]) => `${f} by ${r.paused_by || "?"}`).join(", ") || "none");
  add("INFO", "feature owners", Object.entries(s.features).map(([f, r]) => `${f}=${r.owner}`).join(" "));
  const returning = Object.entries(s.features).filter(([, r]) => r.return_sha);
  add(returning.length ? "FAIL" : "PASS", "no feature being handed back", returning.map(([f]) => f).join(", ") || "none");
  for (const r of evidenceChecks(s)) add(r.level, r.check, r.detail);
  return out;
}
/** Review of PO-2: the H1 evidence gates (plan section 4) - no evidence is a FAIL, never a PASS. -> [{level, check, detail}] */
function evidenceChecks(s) {
  const out = [];
  const add = (level, check, detail) => out.push({ level, check, detail });
  const ev = s.evidence;
  const span = ev.days.length ? `${ev.days[0]}..${ev.days[ev.days.length - 1]}` : `(no complete day since ${ev.from})`;
  const dirtyCounts = (x) => !!(x && x.max && Object.values(x.max).some((n) => Number(n) > 0));
  // gate 1: the mirror diff - checked AND empty every day (and not dirty today)
  const unchecked = ev.days.filter((d) => !ev.mirror[d] || !ev.mirror[d].max);
  const dirty = [...ev.days, ev.today].filter((d) => dirtyCounts(ev.mirror[d]));
  add(!ev.days.length || unchecked.length || dirty.length ? "FAIL" : "PASS", `mirror diff empty every day ${span}`,
      !ev.days.length ? "no complete day in the window - no evidence"
        : [unchecked.length ? `not checked: ${unchecked.join(", ")}` : "", dirty.map((d) => `${d}: ${JSON.stringify(ev.mirror[d].max)}`).join("; ")].filter(Boolean).join("; ")
          || `${ev.days.length} day(s) checked, all empty`);
  // gate 2: the dual read - every daily reader compared every day, and no difference
  const need = [];
  if (s.backends.capital.live) need.push("capital.cutoff");
  if (Object.values(s.engines).some((e) => e.mode && e.mode !== "off")) need.push("policy.source");
  if (s.push) need.push("funding.monetary");
  const by = {};
  for (const c of ev.dual) by[c.day + "|" + c.consumer] = c;
  const missing = [];
  for (const d of ev.days) for (const c of need) if (!(by[d + "|" + c] && Number(by[d + "|" + c].checks) > 0)) missing.push(`${d} ${c}`);
  add(!ev.days.length || missing.length ? "FAIL" : "PASS", `dual read recorded every day ${span} (${need.join(", ") || "no daily reader expected"})`,
      !ev.days.length ? "no complete day in the window - no evidence"
        : missing.length ? `no comparison recorded: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ` (+${missing.length - 20})` : ""}`
        : `${ev.dual.filter((c) => ev.days.includes(c.day)).reduce((t, c) => t + Number(c.checks), 0)} comparison(s)`);
  const diffs = ev.dual.filter((c) => Number(c.diffs) > 0);
  add(diffs.length ? "FAIL" : "PASS", `dual read clean ${ev.from}..${ev.today} (today included)`,
      diffs.length ? diffs.map((c) => `${c.day} ${c.consumer}: ${c.diffs}`).join(", ") + " - see policy_cfg_dualread / the card" : "no difference");
  const other = ev.dual.filter((c) => !need.includes(c.consumer));
  if (other.length) add("INFO", "dual read, other readers", other.map((c) => `${c.day} ${c.consumer}: ${c.checks} check(s)`).join(", "));
  return out;
}

/** `--note "text"` or `--note=text` */
function noteArg(argv) {
  const eq = argv.find((a) => a.startsWith("--note="));
  if (eq) return eq.slice(7);
  const i = argv.indexOf("--note");
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : "";
}
/** PO-1 (T3): pause / resume from the shell (writes; policy/scheduler.setPause - one transaction, audited, admins alerted). */
async function pauseCmd(cmd, target, argv) {
  const actor = (argv.find((a) => a.startsWith("--actor=")) || "").slice(8).trim();
  if (!actor) throw new Error("say who is doing it: --actor=<name>");
  const ENG = ["treasury", "monetary", "burn"];
  const FEAT = ["cfg", "budget", "staking_ops", "loans_desk"];
  if (!target || !(target === "all" || target === "features" || ENG.includes(target) || FEAT.includes(target))) {
    throw new Error(`usage: node tools/policy-backend.js --actor=<who> ${cmd} <treasury|monetary|burn|all | cfg|budget|staking_ops|loans_desk|features> --note "why"`);
  }
  const note = String(noteArg(argv) || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (cmd === "pause" && note.length < 3) throw new Error('say why: --note "..." (every pause is logged and every admin is told)');
  if (target === "features" || FEAT.includes(target)) {
    // PO-2: a feature (policy_ownership.paused) - policy/config.setPause: one transaction, audited, admins alerted
    const PCF = require(path.join(__dirname, "..", "policy", "config"));
    const res = await PCF.setPause(target === "features" ? FEAT : [target], cmd === "pause", { by: `${actor} (cli)`.slice(0, 60), auditId: `cli:${actor}`.slice(0, 64), via: "cli", note: note || null });
    for (const r of res) console.log(r.unchanged ? `${r.feature}: already ${r.paused ? "paused" : "running"} - nothing changed` : `${r.feature}: ${r.paused ? "PAUSED" : "resumed"} by ${actor}`);
    return;
  }
  const SCH = require(path.join(__dirname, "..", "policy", "scheduler"));
  const res = await SCH.setPause(target === "all" ? ENG : [target], cmd === "pause", { by: `${actor} (cli)`.slice(0, 60), auditId: `cli:${actor}`.slice(0, 64), via: "cli", note: note || null });
  for (const r of res) {
    if (r.unchanged) console.log(`${r.engine}: already ${r.paused ? "paused" : "running"} - nothing changed`);
    else console.log(`${r.engine}: ${r.paused ? "PAUSED" : "resumed"} by ${actor}${r.released && r.released.length ? ` - may run late now: ${r.released.join(", ")}` : ""}`);
  }
}

/** The site's database is here (PO-1 review): ./myapp.db exists - checked BEFORE dbUtils loads (it would create an empty one).
 *  -> the absolute path; exits 2 when it isn't there. */
function siteDb(argv) {
  const dir = (argv.find((a) => a.startsWith("--dir=")) || "").slice(6);
  if (dir) process.chdir(path.resolve(dir));
  const db = path.join(process.cwd(), "myapp.db");
  if (!fs.existsSync(db)) {
    console.error(`no myapp.db in ${process.cwd()} - run it in the site directory (cd /home/PATV) or pass --dir=<folder with myapp.db>; nothing was done`);
    process.exit(2);
  }
  return db;
}
/** pause / resume write: only into the site's own database (its users - the admins the alert goes to - and policy_engines). */
async function requireSiteTables(db) {
  const names = new Set((await getQuery("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name));
  const missing = ["users", "policy_engines"].filter((t) => !names.has(t));
  if (missing.length) {
    console.error(`${db} has no ${missing.join(" / ")} table - is this the site's database? Nothing was paused or resumed.`);
    process.exit(2);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--note") { i++; continue; }
    if (!argv[i].startsWith("--")) words.push(argv[i]);
  }
  const [cmd = "status", target] = words;
  const sinceArg = (argv.find((a) => a.startsWith("--since=")) || "").slice(8) || null;
  const db = siteDb(argv);
  if (cmd === "pause" || cmd === "resume") {
    await requireSiteTables(db);
    await pauseCmd(cmd, target, argv);
    tables = null;                                   // the pause created the policy tables if this site never had them
    printStatus(await gather());
    process.exit(0);
  }
  if (!["status", "preflight"].includes(cmd)) throw new Error('usage: node tools/policy-backend.js [status|preflight]   (read-only) | --actor=<who> pause|resume <engine|all|feature|features> --note "why"');
  const s = await gather({ since: sinceArg });
  if (process.argv.includes("--json")) { console.log(JSON.stringify(cmd === "preflight" ? preflight(s) : s, null, 2)); process.exit(0); }
  if (cmd === "status") { printStatus(s); process.exit(0); }
  const res = preflight(s);
  for (const r of res) console.log(`${r.level.padEnd(4)}  ${r.check}: ${r.detail}`);
  const fails = res.filter((r) => r.level === "FAIL").length;
  console.log(fails ? `\npreflight: ${fails} FAIL - not ready` : "\npreflight: the site's half is ready (now Pepe's: !econ policy status)");
  process.exit(fails ? 1 : 0);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { gather, preflight, evidenceChecks, evidenceDays, versionOf, siteVersion };
