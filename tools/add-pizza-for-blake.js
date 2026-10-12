#!/usr/bin/env node
// tools/add-pizza-for-blake.js — 1.99tm: add the official store item "Pizza for Blake" (a pizza delivered to Blake,
// rbg7891) to the prizes table. The picture is public/img/shop/pizza-for-blake.svg (tools/gen-shop-art.py); the
// shelf / delivery / "what you get" line come from shopcatalog.js ITEMS (by the fixed prizeId below) + en.json
// shop.cat.item.pizza_for_blake. Fulfilment + stock are copied from the gift card (37e6ceed-...): DB delivery 'instant'
// (catalog delivery "staff": the PATV team sends it), 5 in stock, no category.
//
// Run in the site directory (it opens ./myapp.db) AFTER the code is deployed (the picture must exist) and after a
// DB backup. Prints the plan; changes nothing without --apply. Idempotent: it refuses to add a second copy - if the
// prizeId OR an official item with the same name already exists, it says so and changes nothing. One admin_audit row.
//   node tools/add-pizza-for-blake.js                       # show
//   node tools/add-pizza-for-blake.js --apply --actor=<who>
"use strict";
const fs = require("fs");
const path = require("path");
const { runQuery, getQuery } = require(path.join(__dirname, "..", "dbUtils"));
const audit = require(path.join(__dirname, "..", "adminaudit"));
const CAT = require(path.join(__dirname, "..", "shopcatalog"));

const ITEM = {
  prizeId: "769d3a54-0ac6-4dbe-873f-c325e77137ec",
  prize: "Pizza for Blake",
  cost: 5000000,          // = the gift card; the closest real-world, hand-delivered item at food-ish value
  quantity: 5,            // copied from the gift card
  delivery: "instant",    // copied (every official row says 'instant'; the catalog says "staff")
  image_url: "/public/img/shop/pizza-for-blake.svg",
};

(async () => {
  const apply = process.argv.includes("--apply");
  const actor = (process.argv.find((a) => a.startsWith("--actor=")) || "").slice(8);
  if (apply && !actor) throw new Error("say who is applying it: --actor=<name>");
  const cat = CAT.ITEMS[ITEM.prizeId];
  if (!cat || cat.key !== "pizza-for-blake") throw new Error("shopcatalog.js has no pizza-for-blake entry - deploy 1.99tm first");
  const art = path.join(process.cwd(), ITEM.image_url.replace(/^\//, ""));
  if (!fs.existsSync(art)) throw new Error(`the picture is not deployed here (${art}) - deploy 1.99tm first`);

  const dup = await getQuery(
    "SELECT prizeId, prize, cost, quantity, status FROM prizes WHERE prizeId = ? OR (seller_id IS NULL AND lower(trim(prize)) = lower(?))",
    [ITEM.prizeId, ITEM.prize]);
  if (dup.length) {
    for (const d of dup) console.log(`== already there, not adding another: ${d.prize} (${d.prizeId}) [${d.status}, ${d.cost.toLocaleString()} PAT, ${d.quantity} in stock]`);
    process.exit(0);
  }
  console.log(`${apply ? "ADD" : "would add"} ${ITEM.prize} (${ITEM.prizeId}): ${ITEM.cost.toLocaleString()} PAT, ${ITEM.quantity} in stock, shelf ${cat.shelf}, delivery ${cat.delivery}, picture ${ITEM.image_url}`);
  if (!apply) process.exit(0);

  const now = Date.now();
  const r = await runQuery(`INSERT INTO prizes (prizeId, prize, cost, quantity, delivery, image_url, status, sold, created, updated)
                            SELECT ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?
                            WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE prizeId = ? OR (seller_id IS NULL AND lower(trim(prize)) = lower(?)))`,
                           [ITEM.prizeId, ITEM.prize, ITEM.cost, ITEM.quantity, ITEM.delivery, ITEM.image_url, now, now, ITEM.prizeId, ITEM.prize]);
  if (!r.changes) { console.log("== someone added it in the meantime; nothing changed"); process.exit(0); }
  await audit.record({ userId: "cli:" + actor, username: actor + " (tools/add-pizza-for-blake.js)" }, "shop_add",
                     { userId: ITEM.prizeId, username: ITEM.prize }, { ...ITEM }, "1.99tm Pizza for Blake");
  console.log("added.");
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
