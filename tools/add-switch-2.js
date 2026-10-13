#!/usr/bin/env node
// tools/add-switch-2.js — 1.99xp: add the official store item "Nintendo Switch 2" to the prizes table. The picture is
// public/img/shop/switch-2.svg (tools/gen-shop-art.py, a_handheld); the shelf / delivery / "what you get" line come from
// shopcatalog.js ITEMS (by the fixed prizeId below) + en.json shop.cat.item.switch_2. Price set by the user: the PAT
// equivalent of $500 at the shop's $1 = 500,000 PAT rule = 250,000,000 PAT. Fulfilment + stock are copied from the
// PS5 Pro (9c0aa228-...): DB delivery 'instant' (catalog delivery "staff": the PATV team sends it), 1 in stock, no
// category, no description.
//
// Run in the site directory (it opens ./myapp.db) AFTER the code is deployed (the picture must exist) and after a
// DB backup. Prints the plan; changes nothing without --apply. Idempotent: it refuses to add a second copy - if the
// prizeId OR an official item with the same name already exists, it says so and changes nothing. The insert and its
// one admin_audit row are written in one dbUtils.tx (both or neither).
//   node tools/add-switch-2.js                       # show
//   node tools/add-switch-2.js --apply --actor=<who>
"use strict";
const fs = require("fs");
const path = require("path");
const { runQuery, getQuery, tx } = require(path.join(__dirname, "..", "dbUtils"));
const audit = require(path.join(__dirname, "..", "adminaudit"));
const CAT = require(path.join(__dirname, "..", "shopcatalog"));

const ITEM = {
  prizeId: "741fa7e3-5804-454f-a064-c5b537fb782a",
  prize: "Nintendo Switch 2",
  cost: 250000000,        // $500 x 500,000 PAT (the user)
  quantity: 1,            // copied from the PS5 Pro
  delivery: "instant",    // copied (every official row says 'instant'; the catalog says "staff")
  image_url: "/public/img/shop/switch-2.svg",
};
const DUP_SQL = "SELECT prizeId, prize, cost, quantity, status FROM prizes WHERE prizeId = ? OR (seller_id IS NULL AND lower(trim(prize)) = lower(?))";

(async () => {
  const apply = process.argv.includes("--apply");
  const actor = (process.argv.find((a) => a.startsWith("--actor=")) || "").slice(8);
  if (apply && !actor) throw new Error("say who is applying it: --actor=<name>");
  const cat = CAT.ITEMS[ITEM.prizeId];
  if (!cat || cat.key !== "switch-2") throw new Error("shopcatalog.js has no switch-2 entry - deploy 1.99xp first");
  const art = path.join(process.cwd(), ITEM.image_url.replace(/^\//, ""));
  if (!fs.existsSync(art)) throw new Error(`the picture is not deployed here (${art}) - deploy 1.99xp first`);

  const dup = await getQuery(DUP_SQL, [ITEM.prizeId, ITEM.prize]);
  if (dup.length) {
    for (const d of dup) console.log(`== already there, not adding another: ${d.prize} (${d.prizeId}) [${d.status}, ${d.cost.toLocaleString()} PAT, ${d.quantity} in stock]`);
    process.exit(0);
  }
  console.log(`${apply ? "ADD" : "would add"} ${ITEM.prize} (${ITEM.prizeId}): ${ITEM.cost.toLocaleString()} PAT, ${ITEM.quantity} in stock, shelf ${cat.shelf}, delivery ${cat.delivery}, picture ${ITEM.image_url}`);
  if (!apply) process.exit(0);

  await audit.init();
  const added = await tx(async () => {
    const now = Date.now();
    const r = await runQuery(`INSERT INTO prizes (prizeId, prize, cost, quantity, delivery, image_url, status, sold, created, updated)
                              SELECT ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?
                              WHERE NOT EXISTS (SELECT 1 FROM prizes WHERE prizeId = ? OR (seller_id IS NULL AND lower(trim(prize)) = lower(?)))`,
                             [ITEM.prizeId, ITEM.prize, ITEM.cost, ITEM.quantity, ITEM.delivery, ITEM.image_url, now, now, ITEM.prizeId, ITEM.prize]);
    if (!r.changes) return false;
    await audit.record({ userId: "cli:" + actor, username: actor + " (tools/add-switch-2.js)" }, "shop_add",
                       { userId: ITEM.prizeId, username: ITEM.prize }, { ...ITEM }, "1.99xp Nintendo Switch 2");
    return true;
  });
  console.log(added ? "added." : "== someone added it in the meantime; nothing changed");
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
