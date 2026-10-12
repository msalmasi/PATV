// shopcatalog.js - 1.99lz: what the shop pages know about the OFFICIAL store items beyond their DB row.
//
// The prizes table holds name / price / stock / image_url. This adds, per official item (by prizeId):
//   key       its catalog key: the picture public/img/shop/<key>.svg (tools/gen-shop-art.py) and the
//             en.json strings shop.cat.item.<tkey> ("what you get" headline; tkey = key with "_" for "-")
//   shelf     which shelf (category chip) it sits on: SHELVES below, names in en.json shop.shelf.<id>
//   delivery  how it reaches the buyer: "instant" (the site applies it at once), "role" (shop.role.* explains it),
//             "invite" (a Plex invite on the order page, mediainvites.js), "staff" (the PATV team delivers it by hand),
//             "retired" (the old request credits; requests are made on /plex)
//   gift      false when it can't be bought for someone else (it's personal to the payer, or retired)
// Items not listed (a new official item, or a member's listing) still work: shelf "market" for listings, "more" for an
// unknown official item, delivery "staff" for official / "seller" for listings.
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
  "71cf8e5a-5d78-46fe-be71-0abf258a6a82": { key: "camfrog-pro-1m", shelf: "camfrog", delivery: "staff" },
  "0a44cc26-98f0-4778-aa67-5bfaf59ee262": { key: "camfrog-pro-1y", shelf: "camfrog", delivery: "staff" },
  "fbcbfa46-b9a3-401e-a6a8-4640f26047f5": { key: "camfrog-extreme-1m", shelf: "camfrog", delivery: "staff" },
  "63f13c8b-9339-4895-b92c-eeefb8949f60": { key: "camfrog-extreme-1y", shelf: "camfrog", delivery: "staff" },
  "cf681df9-ed2d-409f-9ffc-b2d8b63e4ca3": { key: "camfrog-gold-1m", shelf: "camfrog", delivery: "staff" },
  "54c8df0e-1a1f-45c0-8623-046b157da033": { key: "camfrog-gold-1y", shelf: "camfrog", delivery: "staff" },
  "1c120384-c080-4186-b246-f1227e82ab01": { key: "plex-1m", shelf: "plex", delivery: "invite" },
  "a50a2e71-bd6b-467b-ae44-75ae59900637": { key: "plex-1y", shelf: "plex", delivery: "invite" },
  "e101bcff-cc8c-4db9-b4ca-302ef5e16871": { key: "plex-life", shelf: "plex", delivery: "invite" },
  "ff93ad3b-dde3-40c0-a4a7-7bdf9ab7de59": { key: "movie-requests", shelf: "plex", delivery: "retired", gift: false },
  "2aa7a33a-265f-4fa3-98ea-eabad5949a2d": { key: "tv-requests", shelf: "plex", delivery: "retired", gift: false },
  "147ce895-37c2-4c43-98cc-9f7045de0cf3": { key: "role-scout", shelf: "roles", delivery: "role" },
  "c0e57e08-6696-4c51-94ec-485f13a68cd8": { key: "role-curator", shelf: "roles", delivery: "role" },
  "491cde2e-097e-4c2a-a351-ce441137ba38": { key: "role-high-roller", shelf: "roles", delivery: "role" },
  "spinboost100": { key: "spin-boost", shelf: "perks", delivery: "instant", gift: false },
  "178a838b-df7f-42b7-aef4-915d6a8a5c4a": { key: "nitro-1m", shelf: "perks", delivery: "staff" },
  "4b0c7b3c-61f5-4294-a4a4-b932f8977670": { key: "nitro-1y", shelf: "perks", delivery: "staff" },
  "9c0aa228-e0c4-46dd-97cc-dc41a245bc05": { key: "ps5-pro", shelf: "gaming", delivery: "staff" },
  "35433a15-f2d4-4b43-b886-3bdb1686e8b2": { key: "gaming-pc", shelf: "gaming", delivery: "staff" },
  "1289bc9c-4c1f-4f02-b61f-354d4c51ff0b": { key: "gta6", shelf: "gaming", delivery: "staff" },
  "5509b71a-e671-4004-8932-fc82059ace41": { key: "retro-game", shelf: "gaming", delivery: "staff" },
  "0c920cd9-564a-4338-8716-3f4b0250af57": { key: "card-pack", shelf: "goods", delivery: "staff" },
  "37e6ceed-781c-46b6-8644-c134e53338f4": { key: "gift-card", shelf: "goods", delivery: "staff" },
  "02072b01-5ae0-4e4b-ae64-a033a0dc04ea": { key: "watch", shelf: "goods", delivery: "staff" },
  "e2626ad3-82b9-42c3-9ed1-5d6c22e1c6e5": { key: "ring", shelf: "goods", delivery: "staff" },
  "6ba29deb-fe99-43c5-82a9-8fa0a155bf2f": { key: "golden", shelf: "fun", delivery: "staff" },
  "532f7e83-5d6a-4e3f-b876-24019d66452f": { key: "mystery", shelf: "fun", delivery: "staff" },
  "e9c179b4-ee7c-4dcc-b087-dccca9df4725": { key: "probation", shelf: "fun", delivery: "staff" },
  "769d3a54-0ac6-4dbe-873f-c325e77137ec": { key: "pizza-for-blake", shelf: "fun", delivery: "staff" },   // 1.99tm, tools/add-pizza-for-blake.js
};

// The hero + featured strip on /shop, in order; sold-out or inactive ones are skipped.
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

module.exports = { SHELVES, SHELF_IDS, ITEMS, FEATURED, info, shelfIds, knownIds, artRows, artPath, tkey };
