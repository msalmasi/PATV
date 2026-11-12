// shopcatalog.js - 1.99lz: what the shop pages know about the OFFICIAL store items beyond their DB row.
//
// The prizes table holds name / price / stock / image_url. This adds, per official item (by prizeId):
//   key       its catalog key: the picture public/img/shop/<key>.svg (tools/gen-shop-art.py) and the
//             en.json strings shop.cat.item.<tkey> ("what you get" headline; tkey = key with "_" for "-")
//   shelf     which shelf (category chip) it sits on: SHELVES below, names in en.json shop.shelf.<id>
//   delivery  how it reaches the buyer: "instant" (the site applies it at once), "role" (shop.role.* explains it),
//             "invite" (a Plex invite on the order page, mediainvites.js), "staff" (the PATV team sets it up on the account),
//             "collectible" (a VIRTUAL IN-GAME COLLECTIBLE, see below), "retired" (the old request credits; requests are
//             made on /plex)
//   gift      false when it can't be bought for someone else (it's personal to the payer, or retired)
// Items not listed (a new official item, or a member's listing) still work: shelf "market" for listings, "more" for an
// unknown official item, delivery "staff" for official / "seller" for listings.
//
// 1.99ans "collectible" (NY S5935-A, owner 2026-11-11: every prize on PATV is virtual). The 21 items that used to be
// real-world things (Camfrog / Discord Nitro memberships, consoles and games, a gift card, goods, the joke items) are
// virtual in-game collectibles now. A collectible order completes the moment it's bought and that ORDER IS THE RECORD OF
// OWNERSHIP: nothing ships, nothing is set up anywhere, it has no cash value. So no staff task, no "Purchase Notification" /
// raffle-delivery email to the store, no store_alerts (storealerts.js: the vendor never hears), and nothing on the profile
// yet. The pictures stay. The DB rows carry the collectible names + descriptions (COLLECTIBLES below, written once by
// shop.js collectiblesMigration).
"use strict";

const SHELVES = [
  { id: "camfrog", emoji: "🐸" },
  { id: "plex", emoji: "📼" },
  { id: "roles", emoji: "🎖️" },
  { id: "perks", emoji: "⚡" },
  { id: "gaming", emoji: "🎮" },
  { id: "goods", emoji: "💎" },
  { id: "fun", emoji: "🎭" },
  { id: "more", emoji: "🎁" },
  { id: "market", emoji: "🛍️" },
];
const SHELF_IDS = SHELVES.map((s) => s.id);

const ITEMS = {
  "71cf8e5a-5d78-46fe-be71-0abf258a6a82": { key: "camfrog-pro-1m", shelf: "camfrog", delivery: "collectible" },
  "0a44cc26-98f0-4778-aa67-5bfaf59ee262": { key: "camfrog-pro-1y", shelf: "camfrog", delivery: "collectible" },
  "fbcbfa46-b9a3-401e-a6a8-4640f26047f5": { key: "camfrog-extreme-1m", shelf: "camfrog", delivery: "collectible" },
  "63f13c8b-9339-4895-b92c-eeefb8949f60": { key: "camfrog-extreme-1y", shelf: "camfrog", delivery: "collectible" },
  "cf681df9-ed2d-409f-9ffc-b2d8b63e4ca3": { key: "camfrog-gold-1m", shelf: "camfrog", delivery: "collectible" },
  "54c8df0e-1a1f-45c0-8623-046b157da033": { key: "camfrog-gold-1y", shelf: "camfrog", delivery: "collectible" },
  "1c120384-c080-4186-b246-f1227e82ab01": { key: "plex-1m", shelf: "plex", delivery: "invite" },
  "a50a2e71-bd6b-467b-ae44-75ae59900637": { key: "plex-1y", shelf: "plex", delivery: "invite" },
  "e101bcff-cc8c-4db9-b4ca-302ef5e16871": { key: "plex-life", shelf: "plex", delivery: "invite" },
  "ff93ad3b-dde3-40c0-a4a7-7bdf9ab7de59": { key: "movie-requests", shelf: "plex", delivery: "retired", gift: false },
  "2aa7a33a-265f-4fa3-98ea-eabad5949a2d": { key: "tv-requests", shelf: "plex", delivery: "retired", gift: false },
  "147ce895-37c2-4c43-98cc-9f7045de0cf3": { key: "role-scout", shelf: "roles", delivery: "role" },
  "c0e57e08-6696-4c51-94ec-485f13a68cd8": { key: "role-curator", shelf: "roles", delivery: "role" },
  "491cde2e-097e-4c2a-a351-ce441137ba38": { key: "role-high-roller", shelf: "roles", delivery: "role" },
  "spinboost100": { key: "spin-boost", shelf: "perks", delivery: "instant", gift: false },
  "178a838b-df7f-42b7-aef4-915d6a8a5c4a": { key: "nitro-1m", shelf: "perks", delivery: "collectible" },
  "4b0c7b3c-61f5-4294-a4a4-b932f8977670": { key: "nitro-1y", shelf: "perks", delivery: "collectible" },
  "9c0aa228-e0c4-46dd-97cc-dc41a245bc05": { key: "ps5-pro", shelf: "gaming", delivery: "collectible" },
  "741fa7e3-5804-454f-a064-c5b537fb782a": { key: "switch-2", shelf: "gaming", delivery: "collectible" },   // 1.99xp, tools/add-switch-2.js
  "35433a15-f2d4-4b43-b886-3bdb1686e8b2": { key: "gaming-pc", shelf: "gaming", delivery: "collectible" },
  "1289bc9c-4c1f-4f02-b61f-354d4c51ff0b": { key: "gta6", shelf: "gaming", delivery: "collectible" },
  "5509b71a-e671-4004-8932-fc82059ace41": { key: "retro-game", shelf: "gaming", delivery: "collectible" },
  "0c920cd9-564a-4338-8716-3f4b0250af57": { key: "card-pack", shelf: "goods", delivery: "collectible" },
  "37e6ceed-781c-46b6-8644-c134e53338f4": { key: "gift-card", shelf: "goods", delivery: "collectible" },
  "02072b01-5ae0-4e4b-ae64-a033a0dc04ea": { key: "watch", shelf: "goods", delivery: "collectible" },
  "e2626ad3-82b9-42c3-9ed1-5d6c22e1c6e5": { key: "ring", shelf: "goods", delivery: "collectible" },
  "6ba29deb-fe99-43c5-82a9-8fa0a155bf2f": { key: "golden", shelf: "fun", delivery: "collectible" },
  "532f7e83-5d6a-4e3f-b876-24019d66452f": { key: "mystery", shelf: "fun", delivery: "collectible" },
  "e9c179b4-ee7c-4dcc-b087-dccca9df4725": { key: "probation", shelf: "fun", delivery: "collectible" },
  "769d3a54-0ac6-4dbe-873f-c325e77137ec": { key: "pizza-for-blake", shelf: "fun", delivery: "collectible" },   // 1.99tm, tools/add-pizza-for-blake.js
};

// 1.99ans: the collectibles' DB name (prizes.prize) + description (prizes.description), English, written once by shop.js
// collectiblesMigration. Names stay recognisable and say "virtual collectible"; the ones that could be mistaken for
// something redeemable say what they are NOT, because Pepe's !prizes and the Discord /shop list show only the name.
const TAIL = "It's yours on PATV the moment you buy it: the order is your proof of ownership. Nothing is shipped or sent " +
             "anywhere, it can't be exchanged for anything outside PATV, and it has no cash value.";
const col = (name, lead) => ({ name, description: `${lead} ${TAIL}` });
const notMember = (what) => `A virtual in-game collectible for your PATV collection. It is NOT a ${what} membership: nothing is added to any ${what} account.`;
const COLLECTIBLES = Object.freeze({
  "71cf8e5a-5d78-46fe-be71-0abf258a6a82": col("Camfrog Pro 1 Month - virtual collectible, not a membership", notMember("Camfrog")),
  "0a44cc26-98f0-4778-aa67-5bfaf59ee262": col("Camfrog Pro 1 Year - virtual collectible, not a membership", notMember("Camfrog")),
  "fbcbfa46-b9a3-401e-a6a8-4640f26047f5": col("Camfrog Extreme 1 Month - virtual collectible, not a membership", notMember("Camfrog")),
  "63f13c8b-9339-4895-b92c-eeefb8949f60": col("Camfrog Extreme 1 Year - virtual collectible, not a membership", notMember("Camfrog")),
  "cf681df9-ed2d-409f-9ffc-b2d8b63e4ca3": col("Camfrog Gold 1 Month - virtual collectible, not a membership", notMember("Camfrog")),
  "54c8df0e-1a1f-45c0-8623-046b157da033": col("Camfrog Gold 1 Year - virtual collectible, not a membership", notMember("Camfrog")),
  "178a838b-df7f-42b7-aef4-915d6a8a5c4a": col("Discord Nitro 1 Month - virtual collectible, not a membership", notMember("Discord Nitro")),
  "4b0c7b3c-61f5-4294-a4a4-b932f8977670": col("Discord Nitro 1 Year - virtual collectible, not a membership", notMember("Discord Nitro")),
  "9c0aa228-e0c4-46dd-97cc-dc41a245bc05": col("PS5 Pro - virtual collectible", "A virtual in-game collectible: a PS5 Pro for your PATV collection, not a console."),
  "741fa7e3-5804-454f-a064-c5b537fb782a": col("Nintendo Switch 2 - virtual collectible", "A virtual in-game collectible: a Nintendo Switch 2 for your PATV collection, not a console."),
  "35433a15-f2d4-4b43-b886-3bdb1686e8b2": col("Custom Gaming PC - virtual collectible", "A virtual in-game collectible: a custom gaming PC for your PATV collection, not a computer."),
  "1289bc9c-4c1f-4f02-b61f-354d4c51ff0b": col("GTA VI Preorder - virtual collectible", "A virtual in-game collectible: a GTA VI pre-order for your PATV collection. It is not a pre-order and no game is bought."),
  "5509b71a-e671-4004-8932-fc82059ace41": col("Zoltar's Retro Game - virtual collectible", "A virtual in-game collectible: a retro game from Zoltar's Retro Game Store for your PATV collection, not a real game."),
  "0c920cd9-564a-4338-8716-3f4b0250af57": col("Pokemon Card Pack from Tricon - virtual collectible", "A virtual in-game collectible: a pack of Pokemon cards from Tricon for your PATV collection. No cards are sent."),
  "37e6ceed-781c-46b6-8644-c134e53338f4": col("chaosuk.shop Gift Card - virtual collectible, not a gift card", "A virtual in-game collectible. It is NOT a gift card: it holds no balance and can't be redeemed at chaosuk.shop or anywhere else."),
  "02072b01-5ae0-4e4b-ae64-a033a0dc04ea": col("Sugar_Shoes Watch - virtual collectible", "A virtual in-game collectible: one of Sugar_Shoes' watches for your PATV collection, not a real watch."),
  "e2626ad3-82b9-42c3-9ed1-5d6c22e1c6e5": col("Custom Ring from Alex - virtual collectible", "A virtual in-game collectible: a custom ring by Alex for your PATV collection, not real jewellery."),
  "6ba29deb-fe99-43c5-82a9-8fa0a155bf2f": col("Shanks Golden Dildo - virtual collectible", "A virtual in-game collectible: Shanks' legendary golden prize for your PATV collection. There's only one, and nothing is sent."),
  "532f7e83-5d6a-4e3f-b876-24019d66452f": col("? - mystery virtual collectible", "A mystery virtual in-game collectible. There's only one, and which collectible it is stays a secret until someone buys it."),
  "e9c179b4-ee7c-4dcc-b087-dccca9df4725": col("1 Month of Wattz Probation - joke virtual collectible", "A joke virtual collectible. It pays nothing, for Wattz or anyone else: it's a laugh for your PATV collection."),
  "769d3a54-0ac6-4dbe-873f-c325e77137ec": col("Lunch for Blake - joke virtual collectible", "A joke virtual collectible. No food is ordered or delivered, for Blake or anyone else: you just get the credit."),
});
/** Is this prizes row an official virtual collectible? */
const isCollectible = (p) => !!p && !p.seller_id && !!ITEMS[p.prizeId] && ITEMS[p.prizeId].delivery === "collectible";

// 1.99ans: an ORDER of one of those items is a virtual collectible only when it was placed AT OR AFTER THE CUTOVER - the
// moment shop.js collectiblesMigration ran (shop_settings 'collectibles_v1' value.at, handed over with
// setCollectiblesSince at boot). An order placed before it was for the real-world thing and may still be owed: it keeps
// the "staff" delivery (LEGACY_DELIVERY: the old "by the PATV team" label) and its fulfiller (storealerts.js) can still
// open it and see the buyer's details. Until the cutover time is known (before the shop's boot) no order counts as one.
const LEGACY_DELIVERY = "staff";
let SINCE = null;
function setCollectiblesSince(ms) {
  const n = Number(ms);
  SINCE = Number.isFinite(n) && n > 0 ? n : null;
  return SINCE;
}
const collectiblesSince = () => SINCE;
/** Is this ORDER (a shop_orders row: prize_id, official, created) a virtual collectible? */
function isCollectibleOrder(o) {
  if (!o || !o.prize_id || !Number(o.official)) return false;
  if (!isCollectible({ prizeId: String(o.prize_id) })) return false;
  return SINCE != null && Number(o.created) >= SINCE;
}
/** The delivery an ORDER shows: the item's (info().delivery), except that an order of a collectible item placed before the
 *  cutover keeps the old "staff" delivery. */
function orderDelivery(o, inf) {
  const d = inf ? inf.delivery : null;
  return d === "collectible" && !isCollectibleOrder(o) ? LEGACY_DELIVERY : d;
}

// The hero + featured strip on /shop, in order; sold-out or inactive ones are skipped. 1.99ans: the gaming PC stays first -
// it's a virtual collectible now.
const FEATURED = ["35433a15-f2d4-4b43-b886-3bdb1686e8b2", "1c120384-c080-4186-b246-f1227e82ab01",
  "491cde2e-097e-4c2a-a351-ce441137ba38", "spinboost100", "fbcbfa46-b9a3-401e-a6a8-4640f26047f5"];

const artPath = (key) => `/public/img/shop/${key}.svg`;
// en.json keys can't hold "-": shop.cat.item.<key with "_">
const tkey = (key) => String(key).replace(/-/g, "_");

/** What the pages need about one prizes row: {key, shelf, delivery, gift, art}. */
function info(p) {
  if (!p) return null;
  if (p.seller_id) return { key: null, tkey: null, shelf: "market", delivery: "seller", gift: false, art: null };
  const it = ITEMS[p.prizeId];
  if (!it) return { key: null, tkey: null, shelf: "more", delivery: "staff", gift: true, art: null };
  return { key: it.key, tkey: tkey(it.key), shelf: it.shelf, delivery: it.delivery, gift: it.gift !== false, art: artPath(it.key) };
}

/** The prizeIds on one official shelf (for browse's filter). */
function shelfIds(shelf) {
  return Object.entries(ITEMS).filter(([, v]) => v.shelf === shelf).map(([id]) => id);
}
const knownIds = () => Object.keys(ITEMS);

/** The picture for every official item that has none: [{prizeId, key, image_url}] (tools/shop-art-apply.js). */
function artRows() {
  return Object.entries(ITEMS).map(([prizeId, v]) => ({ prizeId, key: v.key, image_url: artPath(v.key) }));
}

module.exports = { SHELVES, SHELF_IDS, ITEMS, FEATURED, COLLECTIBLES, isCollectible, info, shelfIds, knownIds, artRows, artPath, tkey,
                   isCollectibleOrder, orderDelivery, setCollectiblesSince, collectiblesSince, LEGACY_DELIVERY };
