#!/usr/bin/env node
// tools/request-prices.js — 1.99lj: the per-request PAT prices on /requests + /plex (media_settings request_price_movie /
// request_price_tv), user-approved 2026-10-11 as "5x": movie 1,500 -> 7,500, show 7,500 -> 37,500. Scouts still pay
// nothing (mediarequests.js), request credits are still used first.
// Run in the site directory (it opens ./myapp.db), after a DB backup. Prints the before / after; changes nothing without
// --apply. Idempotent: each key changes only while it still holds the expected old value. Every change is an admin_audit
// row (action media_settings) with the actor. The running site reads media_settings at start, so the new prices show
// after its next restart (a deploy restarts it).
//   node tools/request-prices.js                      # show
//   node tools/request-prices.js --apply --actor=<who>
"use strict";
const path = require("path");
const { runQuery, getQuery } = require(path.join(__dirname, "..", "dbUtils"));
const audit = require(path.join(__dirname, "..", "adminaudit"));

const CHANGES = [
  { key: "request_price_movie", from: 1500, to: 7500 },
  { key: "request_price_tv", from: 7500, to: 37500 },
];

(async () => {
  const apply = process.argv.includes("--apply");
  const actor = (process.argv.find((a) => a.startsWith("--actor=")) || "").slice(8);
  if (apply && !actor) throw new Error("say who is applying it: --actor=<name>");
  const show = async (label) => {
    console.log(`-- ${label}`);
    for (const r of await getQuery("SELECT key, value FROM media_settings WHERE key IN ('request_price_movie', 'request_price_tv', 'requests_per_day') ORDER BY key")) {
      console.log(`media_settings ${r.key} = ${r.value}`);
    }
  };
  await show("before");
  if (apply) {
    const who = { userId: "cli:" + actor, username: actor + " (tools/request-prices.js)" };
    for (const c of CHANGES) {
      const r = await runQuery("UPDATE media_settings SET value = ? WHERE key = ? AND value = ?", [JSON.stringify(c.to), c.key, JSON.stringify(c.from)]);
      if (r.changes) await audit.record(who, "media_settings", null, { [c.key]: { from: c.from, to: c.to } }, "per-request prices 5x (user-approved 2026-10-11)");
      console.log(`${c.key}: ${r.changes ? `${c.from} -> ${c.to}` : "unchanged (not at the expected price)"}`);
    }
    await show("after");
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
