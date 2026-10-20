#!/usr/bin/env node
// tools/cflogin.js — CL13: one Camfrog login across Pepe's `!msg` copies (dm_relays) and the admins' own
// "📨 Sent in Camfrog to <login>" logs (conversations.kind = 'cfpm'). For a privacy@ request from someone WITHOUT a PATV
// account (account deletion does the same by itself - accountdelete.js). Train 3: the per-login staff tool on /admin/bridge
// (CL6, chatlogmod.whoAction) now calls messages.cfLoginSummary / cfLoginForget itself (look / export count them, "Delete every
// line" re-keys them) - this tool stays for a shell. Run in the site directory (it opens ./myapp.db), or pass --dir.
// It prints COUNTS only - never a message's text or who sent it (admins read DM text only through a report).
//
//   node tools/cflogin.js --login=<camfrog login> --admin=<staff username> [--reason="..."]
//        the copies naming it (to / from) and the logs named after it
//   node tools/cflogin.js --login=<camfrog login> --admin=<staff username> --reason="<the request>" --forget
//        DRY RUN: the exact changes, rolled back
//   node tools/cflogin.js --login=<camfrog login> --admin=<staff username> --reason="<the request>" --forget --apply
//        one dbUtils.tx: the login becomes a random pseudonym ("deleted-<10 hex>") in dm_relays and in the logs' keys (an
//        admin's log under the pseudonym absorbs it); the copies' text stays - it is the admin's own record
//
// CL13 fix-up - the rules of CL6's per-login staff tool (chatlogmod.whoAction):
//   * --admin must be PATV staff (class Staff or Admin), and every run is audited (admin_audit: cflogin.look /
//     cflogin.forget_dry / cflogin.forget), the applied forget in the SAME transaction as the change. The audit row never
//     holds the login (it must not keep the very name a forget removes): its detail is the counts, plus the pseudonym once
//     applied. Name the request in --reason ("privacy@ 2026-10-20 #12"), not the login;
//   * --forget needs a reason (3+ characters) and is refused while a legal hold covers the login (the chat archive's
//     chatlog_holds 'who:<login>', when that table exists);
//   * nothing creates or alters a table (no messages.init()): pointed at a database without users / admin_audit it stops.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const USAGE = "usage: node tools/cflogin.js --login=<camfrog login> --admin=<staff username> [--reason=\"...\"] [--forget [--apply]] [--dir=<folder with myapp.db>]";
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const has = (k) => process.argv.includes(`--${k}`);
const stop = (code, msg) => { console.error(msg); process.exit(code); };
const login = String(arg("login") || "").trim().replace(/^@/, "").toLowerCase();
const adminName = String(arg("admin") || "").trim().replace(/^@/, "");
const reason = String(arg("reason") || "").replace(/\s+/g, " ").trim().slice(0, 200);
const forget = has("forget"), apply = forget && has("apply");
if (!/^[\w.\-]{1,40}$/.test(login) || !adminName) stop(2, USAGE);
if (forget && reason.length < 3) stop(2, "--forget needs --reason=\"...\" (3+ characters: the request, the order, the case) - it is audited");
if (arg("dir")) process.chdir(path.resolve(String(arg("dir"))));
if (!fs.existsSync(path.join(process.cwd(), "myapp.db"))) stop(2, `no myapp.db in ${process.cwd()}`);
const appDir = path.resolve(__dirname, "..");
const { getQuery, tx } = require(path.join(appDir, "dbUtils"));
const M = require(path.join(appDir, "messages"));
const audit = require(path.join(appDir, "adminaudit"));
const SPC = require(path.join(appDir, "siteperms-core"));
const ROLLBACK = new Error("dry run");
const tableThere = async (t) => (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;

(async () => {
  for (const t of ["users", "admin_audit"]) if (!(await tableThere(t))) stop(2, `no ${t} table in ${path.resolve("myapp.db")} - is this the site's database?`);
  const adm = (await getQuery("SELECT userId, username, class FROM users WHERE lower(username) = lower(?)", [adminName]))[0];
  if (!adm || SPC.classRank(adm) < SPC.classRank("Staff")) stop(2, `--admin ${adminName} is not PATV staff (Staff or Admin)`);
  const who = { userId: adm.userId, username: adm.username };
  const show = (s) => `copies to it: ${s.copies_to}, copies from it: ${s.copies_from}, admins' Camfrog logs named after it: ${s.threads}`;
  const before = await M.cfLoginSummary(login);
  if (!forget) {
    await audit.record(who, "cflogin.look", null, before, reason || null);
    console.log(`${login}: ${show(before)}`);
    return;
  }
  if ((await tableThere("chatlog_holds")) && (await getQuery("SELECT 1 FROM chatlog_holds WHERE key = ?", ["who:" + login])).length) {
    await audit.record(who, "cflogin.forget_refused", null, { why: "legal hold" }, reason);
    stop(1, `${login}: a legal hold covers this login - release it first (nothing changed)`);
  }
  console.log(`${login}: ${show(before)}`);
  const pseudo = "deleted-" + crypto.randomBytes(5).toString("hex");
  let res = null;
  try {
    await tx(async () => {
      res = await M.cfLoginForget(login, pseudo);
      if (!apply) throw ROLLBACK;
      await audit.record(who, "cflogin.forget", null, Object.assign({ pseudonym: pseudo }, res), reason);
    });
  } catch (e) { if (e !== ROLLBACK) throw e; }
  if (!apply) await audit.record(who, "cflogin.forget_dry", null, res, reason);
  console.log(`${apply ? "APPLIED" : "DRY RUN"} ${login} -> ${pseudo}: ${res.relays} copy record(s), ${res.threads} log(s) re-keyed`);
  if (apply) console.log(`${login} now: ${show(await M.cfLoginSummary(login))}`);
  else console.log("dry run - nothing changed (add --apply)");
})().then(() => process.exit(0), (e) => { console.error(e && e.message ? e.message : String(e)); process.exit(1); });
