#!/usr/bin/env node
// tools/store-alert-set.js — 1.99tp: set one "Alert on purchase" recipient on an official store item (storealerts.js) from
// the shell - the same thing as the Alert on purchase section of /shop/admin/edit/<prizeId>, with the same admin_audit row.
//
// Run in the site directory (it opens ./myapp.db) AFTER 1.99tp is deployed. Prints the plan; changes nothing without
// --apply. Idempotent: if the person is already on the item with exactly these settings it says so and changes nothing.
//   node tools/store-alert-set.js --item=<prizeId> --user=<PATV username or Camfrog login> [--tg] [--pm] [--details]
//   node tools/store-alert-set.js ... --apply --actor=<admin username>
//   node tools/store-alert-set.js --item=<prizeId> --user=<name> --remove --apply --actor=<admin username>
// --tg = also Telegram (if they linked it), --pm = also a Camfrog PM from Pepe, --details = they FULFIL the item (the alert
// carries the buyer's Camfrog login + what the buyer typed, and they can open its orders). The 🔔 inbox notice is always sent.
//
// The tricon example (prod): the "Random Pack of Pokemon Cards from Tricon" item, tricon (Camfrog login) as its fulfiller:
//   node tools/store-alert-set.js --item=0c920cd9-564a-4338-8716-3f4b0250af57 --user=tricon --tg --pm --details
"use strict";
const path = require("path");
const { getQuery } = require(path.join(__dirname, "..", "dbUtils"));
const SA = require(path.join(__dirname, "..", "storealerts"));

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ""; };
const has = (k) => process.argv.includes(`--${k}`);

(async () => {
  const item = arg("item"), who = arg("user"), actor = arg("actor");
  const apply = has("apply"), remove = has("remove");
  const want = { tg: has("tg"), pm: has("pm"), details: has("details") };
  if (!item || !who) throw new Error("usage: --item=<prizeId> --user=<username or Camfrog login> [--tg] [--pm] [--details] [--remove] [--apply --actor=<admin>]");
  await SA.init();
  const p = (await getQuery("SELECT prizeId, prize, status, seller_id FROM prizes WHERE prizeId = ?", [item]))[0];
  if (!p) throw new Error(`no item ${item}`);
  if (p.seller_id) throw new Error(`${p.prize} is a member's listing, not an official item`);
  const u = await SA.resolveUser(who);
  const cur = (await SA.forItem(p.prizeId)).find((r) => r.user_id === u.userId) || null;
  console.log(`item:    ${p.prize} (${p.prizeId}, ${p.status})`);
  console.log(`person:  ${u.username} (${u.userId})`);
  console.log(`now:     ${cur ? `on the list - telegram ${cur.tg}, camfrog pm ${cur.pm}, fulfiller details ${cur.details}` : "not on the list"}`);
  console.log(`wanted:  ${remove ? "removed" : `telegram ${want.tg}, camfrog pm ${want.pm}, fulfiller details ${want.details}`}`);
  if (remove ? !cur : (cur && cur.tg === want.tg && cur.pm === want.pm && cur.details === want.details)) {
    console.log("already so - nothing to do.");
    return;
  }
  if (!apply) { console.log("(dry run - add --apply --actor=<admin username> to make the change)"); return; }
  if (!actor) throw new Error("say who is applying it: --actor=<admin username>");
  const a = (await getQuery("SELECT userId, username, class FROM users WHERE LOWER(username) = LOWER(?)", [actor]))[0];
  if (!a || !["Admin", "Staff"].includes(a.class)) throw new Error(`${actor} is not an Admin / Staff account`);
  const r = remove ? await SA.setRecipient({ userId: a.userId, username: a.username }, p.prizeId, "remove", { userId: u.userId })
                   : await SA.setRecipient({ userId: a.userId, username: a.username }, p.prizeId, "add",
                       { who: u.username, tg: want.tg ? "1" : "", pm: want.pm ? "1" : "", details: want.details ? "1" : "" });
  console.log(r.message);
})().then(() => setTimeout(() => process.exit(0), 200)).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
