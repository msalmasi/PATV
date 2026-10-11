#!/usr/bin/env node
// tools/request-roles-setup.js — 1.99la: the one-off store changes that go with the request roles (requestroles.js),
// user-approved 2026-10-11. Run in the site directory (it opens ./myapp.db), after a DB backup. Prints the before /
// after of every request-related store item; changes nothing without --apply. Idempotent (each change is conditional
// on the value it expects), every change is in admin_audit (actions shop_price / shop_retire) with the actor.
//   * 🔭 Scout Role 10,000,000 -> 50,000,000 PAT and 🎟️ Curator Role 5,000,000 -> 25,000,000 PAT (5x)
//   * the request-credit items ("10 Additional Movie Requests", "2 Additional TV Requests") retired: status paused -
//     hidden from the shop, Discord / Pepe lists and the API; their item pages, orders and the credits bought still work.
// The per-request prices on /requests (media_settings) are NOT touched here.
//   node tools/request-roles-setup.js                      # show
//   node tools/request-roles-setup.js --apply --actor=<who>
"use strict";
const path = require("path");
const { runQuery, getQuery } = require(path.join(__dirname, "..", "dbUtils"));
const audit = require(path.join(__dirname, "..", "adminaudit"));

const PRICES = [
  { id: "147ce895-37c2-4c43-98cc-9f7045de0cf3", name: "Scout Role", from: 10000000, to: 50000000 },
  { id: "c0e57e08-6696-4c51-94ec-485f13a68cd8", name: "Curator Role", from: 5000000, to: 25000000 },
];
const RETIRE = ["ff93ad3b-dde3-40c0-a4a7-7bdf9ab7de59", "2aa7a33a-265f-4fa3-98ea-eabad5949a2d"];
const SHOW = [...PRICES.map((p) => p.id), ...RETIRE];

(async () => {
  const apply = process.argv.includes("--apply");
  const actor = (process.argv.find((a) => a.startsWith("--actor=")) || "").slice(8);
  if (apply && !actor) throw new Error("say who is applying it: --actor=<name>");
  const show = async (label) => {
    console.log(`-- ${label}`);
    for (const r of await getQuery(`SELECT prizeId, prize, cost, status, quantity, sold FROM prizes WHERE prizeId IN (${SHOW.map(() => "?").join(",")})`, SHOW)) {
      console.log(`${r.prize} | ${r.cost.toLocaleString("en-US")} PAT | ${r.status} | stock ${r.quantity} | sold ${r.sold || 0}`);
    }
    for (const r of await getQuery("SELECT key, value FROM media_settings WHERE key IN ('request_price_movie', 'request_price_tv', 'requests_per_day')").catch(() => [])) console.log(`media_settings ${r.key} = ${r.value}`);
  };
  await show("before");
  if (apply) {
    const who = { userId: "cli:" + actor, username: actor + " (tools/request-roles-setup.js)" };
    for (const p of PRICES) {
      const r = await runQuery("UPDATE prizes SET cost = ?, updated = ? WHERE prizeId = ? AND seller_id IS NULL AND cost = ?", [p.to, Date.now(), p.id, p.from]);
      if (r.changes) await audit.record(who, "shop_price", null, { prizeId: p.id, item: p.name, from: p.from, to: p.to }, "request roles 5x (user-approved 2026-10-11)");
      console.log(`${p.name}: ${r.changes ? `${p.from} -> ${p.to}` : "unchanged (not at the expected price)"}`);
    }
    for (const id of RETIRE) {
      const r = await runQuery("UPDATE prizes SET status = 'paused', updated = ? WHERE prizeId = ? AND seller_id IS NULL AND status = 'active'", [Date.now(), id]);
      if (r.changes) await audit.record(who, "shop_retire", null, { prizeId: id }, "requests are made on /plex now (user-approved 2026-10-11)");
      console.log(`${id}: ${r.changes ? "retired (paused)" : "unchanged"}`);
    }
    await show("after");
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
