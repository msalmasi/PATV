#!/usr/bin/env node
// tools/username-history.js — 1.99tc: the PATV username history (usernames.js) from the server's shell. Run in the site
// directory (it opens ./myapp.db).
//   node tools/username-history.js                          # dry run of the backfill: the old names it would record
//   node tools/username-history.js --apply                  # write them (idempotent; the site also runs it once on boot)
//   node tools/username-history.js --merge-log=<file> ...   # also read hand-merge run logs ("[DUP-MERGE] old -> new: ..." lines,
//                                                           #   e.g. /root/stale-exec/*-live.txt); repeatable
//   node tools/username-history.js --resolve=<name>[,<name>] # what a username resolves to now (and why)
//   node tools/username-history.js --login=<login>[,<login>] # what a Camfrog login resolves to now (login history included)
//   node tools/username-history.js --old-name=<name>=<userId> [--apply]     # an admin's record: this PATV username used to be
//                                                           #   that account's (dry run without --apply). A Camfrog relink the site
//                                                           #   never saw: tools/login-rekey.js (1.99tj - records follow the account)
//   node tools/username-history.js --user=<userId>          # one account's recorded names + Camfrog logins
"use strict";
const fs = require("fs");
const path = require("path");
const U = require(path.join(__dirname, "..", "usernames"));
const { getQuery } = require(path.join(__dirname, "..", "dbUtils"));

const opt = (k) => process.argv.filter((a) => a.startsWith(`--${k}=`)).map((a) => a.slice(k.length + 3));
(async () => {
  await U.ensure();
  const resolve = opt("resolve").join(",").split(",").map((s) => s.trim()).filter(Boolean);
  if (resolve.length) {
    for (const n of resolve) {
      const r = await U.resolve(n, { strict: true });
      console.log(r.ok ? `${n} -> ${r.user.username} (${r.user.userId}) via ${r.via}` : `${n} -> REFUSED ${r.code}: ${r.error}`);
    }
    return;
  }
  if (opt("old-login").length) throw new Error("--old-login is gone (1.99tj): an old Camfrog login no longer resolves - move its records with tools/login-rekey.js --relink=<login>=<userId>");
  for (const [flag, kind] of [["old-name", "username"]]) {
    const pairs = opt(flag);
    if (!pairs.length) continue;
    for (const pr of pairs) {
      const i = pr.lastIndexOf("=");
      const old = pr.slice(0, i).trim(), uid = pr.slice(i + 1).trim();
      const row = (await getQuery("SELECT userId, username, camfrogUsername FROM users WHERE userId = ?", [uid]))[0];
      if (!old || !row) { console.log(`${pr}: need <old>=<a live userId>`); continue; }
      const now = await (kind === "camfrog" ? U.resolveLogin(old) : U.resolve(old));
      if (now.ok && now.via === "current" && now.user.userId !== uid) { console.log(`${old}: refused - it is ${now.user.username}'s ${kind === "camfrog" ? "login" : "name"} today`); continue; }
      if (!process.argv.includes("--apply")) { console.log(`would record: ${kind} ${old} was ${row.username}'s (${uid}) - add --apply`); continue; }
      const ok = await U.record(uid, old, kind === "camfrog" ? row.camfrogUsername : row.username, "admin", { kind, note: "tools/username-history.js" });
      console.log(ok ? `recorded: ${kind} ${old} -> ${row.username} (${uid})` : `${old}: already recorded`);
    }
    return;
  }
  const logins = opt("login").join(",").split(",").map((s) => s.trim()).filter(Boolean);
  if (logins.length) {
    for (const n of logins) {
      const r = await U.resolveLogin(n, { strict: true });
      console.log(r.ok ? `${n} -> ${r.user.username} (${r.user.userId}, linked ${r.user.camfrogUsername || "-"}) via ${r.via}` : `${n} -> REFUSED ${r.code}: ${r.error}`);
    }
    return;
  }
  const user = opt("user")[0];
  if (user) {
    for (const r of await getQuery("SELECT kind, old_username, new_username, datetime(at/1000, 'unixepoch') AS at, via, note FROM username_history WHERE userId = ? ORDER BY at", [user])) {
      console.log(`${r.at}  ${r.kind.padEnd(8)} ${r.via.padEnd(14)} ${r.old_username} -> ${r.new_username || "?"}  ${r.note || ""}`);
    }
    return;
  }
  const lines = [];
  for (const f of opt("merge-log")) lines.push(...fs.readFileSync(f, "utf8").split(/\r?\n/));
  const apply = process.argv.includes("--apply");
  const r = await U.backfill({ apply, mergeLogLines: lines });
  for (const x of r.rows) console.log(`${x.kind.padEnd(8)} ${x.via.padEnd(6)} ${x.old} -> ${x.now || "?"} (${x.userId})  ${x.note || ""}`);
  for (const s of r.skipped) console.log(`skipped: ${s}`);
  for (const s of r.unresolvedLog) console.log(`merge log line not resolved: ${s}`);
  console.log(`${r.found} old name(s) found; ${apply ? `${r.written} written` : "dry run (--apply to write)"}`);
})().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
