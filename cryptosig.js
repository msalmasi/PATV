// cryptosig.js — 1.99ks: wallet-ownership proofs for crypto donations (cryptopay.js). Pure functions, no network, no keys.
//
// A wallet is linked to a PATV account ONLY by a signature over a message this server wrote (a nonce, the domain, an
// expiry). A typed address is never trusted.
//   EVM (Ethereum + Base share an address): Sign-In-With-Ethereum, EIP-4361 text, signed with personal_sign (EIP-191).
//     The address is recovered from the signature (secp256k1 public-key recovery) and must equal the one in the message.
//     Contract wallets (EIP-1271 / smart accounts) can't be verified this way and are refused.
//   Solana: a plain text message signed with the wallet's ed25519 key (Phantom / Solflare signMessage); the address IS
//     the public key, so Node's own ed25519 verify does it.
// Libraries: @noble/curves (secp256k1) + @noble/hashes (keccak-256) - audited, dependency-free, pinned exact versions.
"use strict";
const crypto = require("crypto");
const { secp256k1 } = require("@noble/curves/secp256k1");
const { keccak_256 } = require("@noble/hashes/sha3");

// ── base58 (Bitcoin alphabet, as Solana uses) ──
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = (() => { const m = {}; for (let i = 0; i < B58.length; i++) m[B58[i]] = i; return m; })();
function b58decode(s) {
  s = String(s || "");
  if (!s || s.length > 120) return null;
  let n = 0n;
  for (const c of s) {
    const v = B58_MAP[c];
    if (v === undefined) return null;
    n = n * 58n + BigInt(v);
  }
  const out = [];
  while (n > 0n) { out.push(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === "1") out.push(0); else break; }
  return Buffer.from(out.reverse());
}
function b58encode(buf) {
  const b = Buffer.from(buf);
  let n = 0n;
  for (const x of b) n = (n << 8n) + BigInt(x);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x === 0) s = "1" + s; else break; }
  return s;
}

// ── addresses ──
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const keccakHex = (data) => Buffer.from(keccak_256(typeof data === "string" ? Buffer.from(data, "utf8") : data)).toString("hex");
/** EIP-55 mixed-case checksum form of an EVM address (input any case). */
function toChecksum(addr) {
  if (!EVM_RE.test(String(addr || ""))) return null;
  const a = String(addr).slice(2).toLowerCase();
  const h = keccakHex(a);
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  return out;
}
/** A normalized EVM address (lower case), or null. A mixed-case input must carry a valid EIP-55 checksum. */
function normEvm(addr) {
  const s = String(addr || "").trim();
  if (!EVM_RE.test(s)) return null;
  const body = s.slice(2);
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && toChecksum(s) !== s) return null;
  if (/^0x0{40}$/i.test(s)) return null;
  return s.toLowerCase();
}
/** A Solana address (base58 of a 32-byte ed25519 public key), or null. */
function normSol(addr) {
  const s = String(addr || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return null;
  const b = b58decode(s);
  return b && b.length === 32 ? s : null;
}
const norm = (family, addr) => (family === "evm" ? normEvm(addr) : family === "sol" ? normSol(addr) : null);

// ── messages ──
const ISO = (ms) => new Date(ms).toISOString();
/**
 * The EIP-4361 message for linking `address` (checksummed in the text, as the spec asks).
 * opts: domain (host, e.g. publicaccess.tv), uri (https://publicaccess.tv), nonce (>= 8 alphanumerics), issuedAt,
 * expiresAt (ms), username (shown in the statement), chainId (1).
 */
function siweMessage({ domain, uri, address, nonce, issuedAt, expiresAt, username, chainId = 1 }) {
  const a = toChecksum(address);
  if (!a) throw new Error("bad address");
  if (!/^[A-Za-z0-9]{8,64}$/.test(String(nonce || ""))) throw new Error("bad nonce");
  const who = String(username || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40);
  const statement = `Link this wallet to the PATV account ${who} so its USDC/USDT donations can be credited. Signing is free and allows no transaction.`;
  return `${domain} wants you to sign in with your Ethereum account:\n${a}\n\n${statement}\n\nURI: ${uri}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${ISO(issuedAt)}\nExpiration Time: ${ISO(expiresAt)}`;
}
/** The fields of an EIP-4361 message (only what we check). */
function parseSiwe(msg) {
  const lines = String(msg || "").split("\n");
  const m = /^(\S+) wants you to sign in with your Ethereum account:$/.exec(lines[0] || "");
  if (!m) return null;
  const f = { domain: m[1], address: lines[1] || "" };
  for (const l of lines.slice(2)) {
    const i = l.indexOf(": ");
    if (i > 0) f[l.slice(0, i)] = l.slice(i + 2);
  }
  return f;
}
function solMessage({ domain, address, nonce, issuedAt, expiresAt, username }) {
  if (!normSol(address)) throw new Error("bad address");
  if (!/^[A-Za-z0-9]{8,64}$/.test(String(nonce || ""))) throw new Error("bad nonce");
  const who = String(username || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40);
  return `${domain} wants you to link your Solana wallet to the PATV account ${who}.\n\nSo its USDC/USDT donations can be credited. Signing is free and allows no transaction.\n\nWallet: ${address}\nNonce: ${nonce}\nIssued At: ${ISO(issuedAt)}\nExpiration Time: ${ISO(expiresAt)}`;
}

// ── verification ──
/** EIP-191 personal_sign digest of a UTF-8 message. */
function personalHash(msg) {
  const body = Buffer.from(String(msg), "utf8");
  return Buffer.from(keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, "utf8"), body])));
}
/** The (lower-case) address that signed `msg` with personal_sign, or null. */
function recoverEvm(msg, sigHex) {
  const s = String(sigHex || "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{130}$/.test(s)) return null;
  const sig = Buffer.from(s, "hex");
  let v = sig[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  try {
    const pub = secp256k1.Signature.fromCompact(sig.subarray(0, 64)).addRecoveryBit(v).recoverPublicKey(personalHash(msg)).toRawBytes(false);
    return "0x" + keccakHex(Buffer.from(pub.subarray(1))).slice(24);
  } catch (e) { return null; }
}
function verifyEvm(msg, sigHex, address) {
  const want = normEvm(address);
  const got = recoverEvm(msg, sigHex);
  return !!want && !!got && got === want;
}
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
/** Does `sig` (64 bytes: hex, base58 or base64) sign the UTF-8 `msg` for Solana `address`? */
function verifySol(msg, sig, address) {
  const pk = normSol(address) && b58decode(address);
  if (!pk || pk.length !== 32) return false;
  const s = String(sig || "").trim();
  let raw = null;
  if (/^(0x)?[0-9a-fA-F]{128}$/.test(s)) raw = Buffer.from(s.replace(/^0x/, ""), "hex");
  else if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s)) raw = b58decode(s);
  else if (/^[A-Za-z0-9+/]{86}={0,2}$/.test(s)) raw = Buffer.from(s, "base64");
  if (!raw || raw.length !== 64) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, pk]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(String(msg), "utf8"), key, raw);
  } catch (e) { return false; }
}

module.exports = { b58decode, b58encode, toChecksum, normEvm, normSol, norm, siweMessage, parseSiwe, solMessage,
                   personalHash, recoverEvm, verifyEvm, verifySol, keccakHex };
