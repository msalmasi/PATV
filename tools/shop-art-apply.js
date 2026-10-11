#!/usr/bin/env node
// tools/shop-art-apply.js — 1.99lz: give every official store item that has NO picture its pixel-art picture
// (public/img/shop/<key>.svg, drawn by tools/gen-shop-art.py; the item -> picture map is shopcatalog.js ITEMS).
// Only prizes.image_url changes, and only where it is empty: prices, stock, names and pictures someone already set are
// never touched. Run in the site directory (it opens ./myapp.db), after a DB backup. Prints the plan; changes nothing
// without --apply. Idempotent. Every change is an admin_audit row (action shop_image) with the actor.
// The pages already fall back to the catalog picture, so this only makes the DB say what the site shows.
//   node tools/shop-art-apply.js                      # show
//   node tools/shop-art-apply.js --apply --actor=<who>
"use strict";
const path = require("path");
const { runQuery, getQuery } = require(path.join(__dirname, "..", "dbUtils"));
const audit = require(path.join(__dirname, "..", "adminaudit"));
const CAT = require(path.join(__dirname, "..", "shopcatalog"));

(async () => {
  const apply = process.argv.includes("--apply");
  const actor = (process.argv.find((a) => a.startsWith("--actor=")) || "").slice(8);
  if (apply && !actor) throw new Error("say who is applying it: --actor=<name>");
  const who = { userId: "cli:" + actor, username: actor + " (tools/shop-art-apply.js)" };
  const rows = await getQuery("SELECT prizeId, prize, cost, image_url, status FROM prizes WHERE seller_id IS NULL");
  const byId = new Map(rows.map((r) => [r.prizeId, r]));
  let changed = 0, skipped = 0, missing = 0;
  for (const a of CAT.artRows()) {
    const r = byId.get(a.prizeId);
    if (!r) { missing++; console.log(`-- not in this DB: ${a.key} (${a.prizeId})`); continue; }
    if (r.image_url) { skipped++; console.log(`== keeps its picture: ${r.prize} -> ${r.image_url}`); continue; }
    console.log(`${apply ? "SET" : "would set"} ${r.prize} [${r.status}, ${r.cost.toLocaleString()} PAT] -> ${a.image_url}`);
    if (!apply) continue;
    const u = await runQuery("UPDATE prizes SET image_url = ?, updated = ? WHERE prizeId = ? AND seller_id IS NULL AND (image_url IS NULL OR image_url = '')",
                             [a.image_url, Date.now(), a.prizeId]);
    if (u.changes) { changed++; await audit.record(who, "shop_image", { userId: a.prizeId, username: r.prize }, { title: r.prize, from: null, to: a.image_url }, "1.99lz shop pictures"); }
  }
  const left = await getQuery("SELECT prize FROM prizes WHERE seller_id IS NULL AND status != 'removed' AND (image_url IS NULL OR image_url = '')");
  console.log(`${apply ? "changed" : "to change"}: ${apply ? changed : CAT.artRows().length - skipped - missing}, kept: ${skipped}, not in DB: ${missing}; official items still without a picture: ${left.length}${left.length ? " (" + left.map((x) => x.prize).join(", ") + ")" : ""}`);
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
