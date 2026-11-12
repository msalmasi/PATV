// shopReply.js - 1.99ans: the Discord /shop purchase reply (commands/shop.js), by how the item reaches the buyer: the
// `delivery` /api/prizes carries (shopcatalog.js) or the `collectible` flag /chatshop returns.
//   collectible  a VIRTUAL IN-GAME COLLECTIBLE (NY S5935-A, owner 2026-11-11): it's in the buyer's PATV collection the
//                moment they buy - nothing is activated, shipped or sent, and it has no cash value. Never "wait for activation".
//   instant      applied at once (the spin boost)
//   role / invite / staff / anything else   the old "up to 24 hours for activation" line
// No Discord dependencies, so the site's tests can check the wording (test/discord-shop-reply.test.js).
"use strict";

function purchaseReply({ name, cost, balance, delivery, collectible }) {
  const head = `You successfully purchased ${name} (PAT ${cost})! You have PAT ${balance}.`;
  if (collectible || delivery === "collectible") {
    return `${head} It's a virtual in-game collectible: it's in your PATV collection now, and your order on publicaccess.tv is the record that you own it. Nothing is shipped or activated; it has no cash value.`;
  }
  if (delivery === "instant") return `${head} It's on your account now.`;
  return `${head} Please wait up to 24 hours for activation.`;
}

module.exports = { purchaseReply };
