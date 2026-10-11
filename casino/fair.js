// casino/fair.js — provably fair shoes for the casino backend (1.99lj; docs/casino-backend.md section 6).
//
// Commit / reveal with a client seed (the v2 standard):
//   * each round gets a secret server_seed (32 random bytes, hex) when its BETTING opens, and the table publishes
//     commitment = sha256(server_seed) (hex of the seed's UTF-8 text) before anyone bets;
//   * the table's client_seed is public (shown on the page from the moment the table opens);
//   * the shoe is a Fisher-Yates shuffle of `numDecks` fresh decks (makeShoe order) driven by the byte stream
//     HMAC-SHA256(key = server_seed, message = `${client_seed}:${round}:${counter}`), counter = 0, 1, 2 ...,
//     each digest read as eight big-endian 32-bit words; a draw below n uses rejection sampling (no modulo bias);
//   * after the round the seed is revealed; anyone can re-derive the shoe (verify(), or the browser on /casino/fair).
"use strict";
const crypto = require("crypto");
const { makeShoe } = require("./bjengine");

const newServerSeed = () => crypto.randomBytes(32).toString("hex");
const newClientSeed = () => crypto.randomBytes(8).toString("hex");
const commitment = (serverSeed) => crypto.createHash("sha256").update(String(serverSeed), "utf8").digest("hex");

/** A generator of uint32 words from the seeds. */
function words(serverSeed, clientSeed, round) {
  let counter = 0, buf = null, pos = 8;
  return () => {
    if (pos >= 8) {
      buf = crypto.createHmac("sha256", String(serverSeed)).update(`${clientSeed}:${round}:${counter++}`, "utf8").digest();
      pos = 0;
    }
    return buf.readUInt32BE(4 * pos++);
  };
}

/** A uniform integer in [0, n) from the word stream. */
function below(next, n) {
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    const x = next();
    if (x < limit) return x % n;
  }
}

function shuffleShoe(numDecks, serverSeed, clientSeed, round) {
  const shoe = makeShoe(numDecks);
  const next = words(serverSeed, clientSeed, round);
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = below(next, i + 1);
    const tmp = shoe[i]; shoe[i] = shoe[j]; shoe[j] = tmp;
  }
  return shoe;
}

/** rec: {commitment, server_seed, client_seed, round, num_decks, shoe?} -> {ok, commitment_ok, shoe_ok, shoe} */
function verify(rec) {
  if (!rec || !rec.server_seed) return { ok: false, reason: "the seed isn't revealed yet" };
  const commitmentOk = commitment(rec.server_seed) === String(rec.commitment || "");
  const shoe = shuffleShoe(Number(rec.num_decks) || 6, rec.server_seed, rec.client_seed, rec.round);
  const shoeOk = !rec.shoe || (Array.isArray(rec.shoe) && rec.shoe.length === shoe.length && rec.shoe.every((c, i) => c === shoe[i]));
  return { ok: commitmentOk && shoeOk, commitment_ok: commitmentOk, shoe_ok: shoeOk, shoe };
}

module.exports = { newServerSeed, newClientSeed, commitment, shuffleShoe, verify, words, below };
