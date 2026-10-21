// Offline tests for 1.99ks stablecoin donations (cryptopay.js, cryptosig.js, cryptoweb.js). No network: the parsers run on
// RECORDED mainnet RPC responses (test/fixtures/crypto, captured 2026-10-10 from public RPCs) and the watcher on a mocked
// JSON-RPC. Wallet signatures are made here with throwaway test keys.
//   NODE_PATH=G:/PATV/node_modules node --test test/crypto-donations.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const nodeCrypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const FX = path.join(__dirname, "fixtures", "crypto");
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FX, n), "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crypto-test-"));
process.chdir(tmp);
delete process.env.STAGING;
for (const k of ["CRYPTO_RPC_ETH", "CRYPTO_RPC_BASE", "CRYPTO_RPC_SOL", "STRIPE_ENABLED"]) delete process.env[k];
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { secp256k1 } = require("@noble/curves/secp256k1");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const SIG = require(path.join(repo, "cryptosig"));
const CP = require(path.join(repo, "cryptopay"));
const F = require(path.join(repo, "funding"));

let t = Date.UTC(2026, 9, 10, 12);
CP._setClock(() => t);
const USERS = {};
let server, base;

// ── test wallets ──
function evmWallet(seed) {
  const priv = nodeCrypto.createHash("sha256").update("evm-" + seed).digest();
  const pub = secp256k1.getPublicKey(priv, false);
  const address = "0x" + SIG.keccakHex(Buffer.from(pub.subarray(1))).slice(24);
  return { priv, address, sign: (msg) => { const s = secp256k1.sign(SIG.personalHash(msg), priv); return "0x" + Buffer.from(s.toCompactRawBytes()).toString("hex") + (27 + s.recovery).toString(16); } };
}
function solWallet() {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return { address: SIG.b58encode(raw), sign: (msg) => nodeCrypto.sign(null, Buffer.from(msg, "utf8"), privateKey).toString("hex") };
}

function raw(method, url, { body, user, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ Origin: base, "Content-Type": "application/json" }, headers);
    if (user) h["x-test-user"] = user;
    const b = body == null ? null : JSON.stringify(body);
    if (b != null) h["Content-Length"] = Buffer.byteLength(b);
    const r = http.request(base + url, { method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const s = Buffer.concat(chunks).toString("utf8"); let j = null; try { j = JSON.parse(s); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j, text: s }); });
    });
    r.on("error", reject);
    if (b != null) r.write(b);
    r.end();
  });
}
async function link(user, family, w) {
  const s = await raw("POST", "/api/crypto/link/start", { user, body: { family, address: w.address } });
  assert.equal(s.status, 200, s.text);
  const f = await raw("POST", "/api/crypto/link/finish", { user, body: { nonce: s.json.nonce, signature: w.sign(s.json.message) } });
  return { start: s, finish: f };
}
const bal = async (u) => (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [USERS[u].userId]))[0].points_balance;
const claims = () => getQuery("SELECT claimId, flow, userId, type, amount, meta FROM reserve_claims WHERE flow = 'mint:donation' ORDER BY created, rowid");
const pay = (id) => getQuery("SELECT * FROM crypto_payments WHERE id = ?", [id]).then((r) => r[0]);

// ── a mocked JSON-RPC for the watcher ──
const CHAIN = { eth: { head: 0, final: 0, logs: [] }, sol: { slot: 1000, accounts: {}, sigs: {}, txs: {} } };
const calls = [];
function mockFetch(url, opts) {
  url = String(url);
  const b = JSON.parse(opts.body);
  calls.push(b.method);
  const ok = (result) => Promise.resolve({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
  const E = CHAIN.eth, S = CHAIN.sol;
  switch (b.method) {
    case "eth_blockNumber": return ok("0x" + E.head.toString(16));
    case "eth_getBlockByNumber": return ok(b.params[0] === "finalized" ? { number: "0x" + E.final.toString(16) } : null);
    case "eth_getLogs": {
      const q = b.params[0];
      const lo = parseInt(q.fromBlock, 16), hi = parseInt(q.toBlock, 16);
      return ok(E.logs.filter((l) => { const n = parseInt(l.blockNumber, 16); return n >= lo && n <= hi && q.address.includes(l.address) && l.topics[2] === q.topics[2]; }));
    }
    case "eth_getTransactionReceipt": {
      const ls = E.logs.filter((l) => l.transactionHash === b.params[0]);
      if (!ls.length) return ok(null);
      const tamper = CHAIN.tamper && url.includes("drpc");
      return ok({ status: "0x1", blockNumber: ls[0].blockNumber, logs: ls.map((l) => (tamper ? { ...l, data: "0x" + "0".repeat(63) + "9" } : l)) });
    }
    case "getSlot": return ok(S.slot);
    case "getTokenAccountsByOwner": {
      const [owner, { mint }] = b.params;
      return ok({ value: (S.accounts[mint] || []).map((a) => ({ pubkey: a, account: { data: { parsed: { info: { mint, owner } } } } })) });
    }
    case "getSignaturesForAddress": {
      const [acct, o] = b.params;
      let list = (S.sigs[acct] || []).slice().reverse();          // newest first
      if (o.until) { const i = list.findIndex((x) => x.signature === o.until); if (i >= 0) list = list.slice(0, i); }
      return ok(list.slice(0, o.limit || 1000));
    }
    case "getTransaction": return ok(S.txs[b.params[0]] || null);
    default: return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: { message: "unknown" } }) });
  }
}
const RECV = "0xbd329b245135fcf5539f4d1ef40ba2d310e761a1";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const pad = (a) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const logOf = ({ from, block, tx, li, usd, token = USDC, to = RECV }) => ({ address: token, topics: [CP.TRANSFER_TOPIC, pad(from), pad(to)],
  data: "0x" + BigInt(Math.round(usd * 1e6)).toString(16).padStart(64, "0"), blockNumber: "0x" + block.toString(16),
  transactionHash: "0x" + tx.padStart(64, "0"), logIndex: "0x" + li.toString(16), removed: false });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const n of ["alice", "bob", "carol", "boss"]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance, class) VALUES (?, ?, ?, 'x', 0, ?)", ["u-" + n, n, n, n === "boss" ? "Admin" : "pleb"]);
    USERS[n] = { userId: "u-" + n, username: n, class: n === "boss" ? "Admin" : "pleb" };
  }
  // owner answers 2026-10-20 (1): approving / re-verifying a held payment credits PAT - a Pepe owner's. boss's account is linked
  // to an owner login
  await runQuery("UPDATE users SET camfrogUsername = 'boss_cf' WHERE userId = 'u-boss'");
  await require(path.join(repo, "staffroles")).init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('boss_cf', 'owner', 1)");
  await CP.init();
  CP._setFetch(mockFetch);
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(express.json());
  const addUser = (rq, rs, next) => { const u = rq.get("x-test-user"); rq.user = u ? USERS[u] || null : null; next(); };
  require(path.join(repo, "cryptoweb")).register(app, { addUser, noTimers: true });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { CP.stop(); server && server.close(); });

// ── the reviewed token table ──
test("token table: exactly the reviewed Circle / Tether addresses; no USDT on Base", () => {
  assert.deepEqual(Object.keys(CP.TOKENS.eth).sort(), ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7"]);
  assert.deepEqual(Object.keys(CP.TOKENS.base), ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]);
  assert.deepEqual(Object.keys(CP.TOKENS.sol).sort(), ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
  for (const c of Object.values(CP.TOKENS)) for (const x of Object.values(c)) assert.equal(x.decimals, 6);
  assert.ok(Object.isFrozen(CP.TOKENS.eth));
  assert.equal(SIG.toChecksum(USDC), "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "EIP-55 matches Circle's published form");
  assert.equal(CP.TRANSFER_TOPIC, "0x" + SIG.keccakHex("Transfer(address,address,uint256)"));
});

// ── EVM parsing (recorded mainnet logs) ──
test("EVM: recorded Ethereum + Base Transfer logs -> only reviewed tokens to our address, face value in cents, key chain:tx:logIndex", () => {
  const logs = fx("eth-logs.json");
  const usdc = logs.find((l) => l.address === USDC);
  const to = "0x" + usdc.topics[2].slice(26);
  const got = CP.parseEvmLogs("eth", logs, to);
  assert.equal(got.length, 1);
  const g = got[0];
  assert.equal(g.id, `eth:${usdc.transactionHash}:${parseInt(usdc.logIndex, 16)}`);
  assert.equal(g.token, "USDC");
  assert.equal(g.src_addr, "0x" + usdc.topics[1].slice(26));
  assert.equal(g.raw_amount, BigInt(usdc.data).toString());
  assert.equal(g.usd_cents, Math.floor(Number(BigInt(usdc.data)) / 1e4));
  // the USDT log + a foreign token in the same block: USDT parses for its own recipient, the foreign one never does
  const usdt = logs.find((l) => l.address === "0xdac17f958d2ee523a2206206994597c13d831ec7");
  assert.equal(CP.parseEvmLogs("eth", logs, "0x" + usdt.topics[2].slice(26))[0].token, "USDT");
  const foreign = logs.find((l) => !CP.TOKENS.eth[l.address]);
  assert.equal(CP.parseEvmLogs("eth", [foreign], "0x" + foreign.topics[2].slice(26)).length, 0, "a token not in the table is never credited");
  assert.equal(CP.parseEvmLogs("eth", [{ ...usdc, removed: true }], to).length, 0, "removed (reorged) logs are ignored");
  assert.equal(CP.parseEvmLogs("base", [usdc], to).length, 0, "Ethereum's USDC address means nothing on Base");
  const bl = fx("base-logs.json");
  const busdc = bl.find((l) => l.address === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  const bg = CP.parseEvmLogs("base", bl, "0x" + busdc.topics[2].slice(26));
  assert.equal(bg.length, 1);
  assert.match(bg[0].id, /^base:0x[0-9a-f]{64}:\d+$/);
});
test("amounts: 6-decimal face value, floor to cents", () => {
  assert.equal(CP.centsOf("1000000", 6), 100);
  assert.equal(CP.centsOf("1009999", 6), 100);
  assert.equal(CP.centsOf("999999", 6), 99);
  assert.equal(CP.centsOf("0", 6), 0);
  assert.equal(CP.centsOf("garbage", 6), 0);
});

// ── Solana parsing (recorded mainnet transactions) ──
test("Solana: recorded transfer / transferChecked (outer + inner) -> the transfer into the token account, sender = source owner", () => {
  for (const f of ["sol-EPjF-0.json", "sol-EPjF-1.json", "sol-Es9v-0.json", "sol-Es9v-1.json"]) {
    const j = fx(f);
    const tx = j.tx;
    const [a, b] = j.hit.split(".");
    const ix = b === undefined ? tx.transaction.message.instructions[+a] : tx.meta.innerInstructions.find((g) => g.index === +a).instructions[+b];
    const info = ix.parsed.info;
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
    const dst = tx.meta.postTokenBalances.find((x) => keys[x.accountIndex] === info.destination);
    const src = [].concat(tx.meta.preTokenBalances, tx.meta.postTokenBalances).find((x) => keys[x.accountIndex] === info.source);
    const got = CP.parseSolTx(j.signature, tx, info.destination, j.mint, dst.owner).filter((x) => x.id === `sol:${j.signature}:${j.hit}`);
    assert.equal(got.length, 1, f);
    assert.equal(got[0].raw_amount, info.amount || info.tokenAmount.amount, f);
    assert.equal(got[0].src_addr, src ? src.owner : info.authority, f);
    assert.equal(got[0].token, j.mint.startsWith("EPj") ? "USDC" : "USDT");
    assert.equal(got[0].dst_addr, dst.owner);
    // a failed transaction, or the other mint's table entry, credits nothing
    assert.equal(CP.parseSolTx(j.signature, { ...tx, meta: { ...tx.meta, err: { InstructionError: [0, "x"] } } }, info.destination, j.mint, dst.owner).length, 0);
    const other = j.mint.startsWith("EPj") ? "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    assert.equal(CP.parseSolTx(j.signature, tx, info.destination, other, dst.owner).length, 0, "a token account of one mint never counts as the other");
  }
});

// ── signatures ──
test("EVM signatures: EIP-191 recovery, a known key -> address vector, tampering / the wrong address fail", () => {
  // ethers' well-known test key 0x0123...0123 -> 0x14791697260E4c9A71f18484C9f997B308e59325
  const priv = Buffer.from("0123456789012345678901234567890123456789012345678901234567890123", "hex");
  const addr = "0x" + SIG.keccakHex(Buffer.from(secp256k1.getPublicKey(priv, false).subarray(1))).slice(24);
  assert.equal(SIG.toChecksum(addr), "0x14791697260E4c9A71f18484C9f997B308e59325");
  const w = evmWallet("a");
  const msg = SIG.siweMessage({ domain: "publicaccess.tv", uri: "https://publicaccess.tv", address: w.address, nonce: "abcdef0123456789", issuedAt: t, expiresAt: t + 600000, username: "alice" });
  assert.match(msg, /^publicaccess\.tv wants you to sign in with your Ethereum account:\n0x[0-9a-fA-F]{40}\n\n/);
  assert.match(msg, /\nURI: https:\/\/publicaccess\.tv\nVersion: 1\nChain ID: 1\nNonce: abcdef0123456789\nIssued At: 2026-10-10T12:00:00.000Z\nExpiration Time: 2026-10-10T12:10:00.000Z$/);
  const s = w.sign(msg);
  assert.equal(SIG.recoverEvm(msg, s), w.address);
  assert.ok(SIG.verifyEvm(msg, s, SIG.toChecksum(w.address)));
  assert.ok(!SIG.verifyEvm(msg + " ", s, w.address), "tampered message");
  assert.ok(!SIG.verifyEvm(msg, s, evmWallet("b").address), "someone else's address");
  assert.ok(!SIG.verifyEvm(msg, "0x1234", w.address));
  const f = SIG.parseSiwe(msg);
  assert.equal(f.domain, "publicaccess.tv"); assert.equal(f.Nonce, "abcdef0123456789");
  assert.equal(SIG.normEvm("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB4"), null);
  assert.equal(SIG.normEvm("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eb48"), null, "a broken EIP-55 checksum is refused");
});
test("Solana signatures: ed25519 over the text, hex / base58 / base64; base58 round-trips", () => {
  const w = solWallet();
  const msg = SIG.solMessage({ domain: "publicaccess.tv", address: w.address, nonce: "abcdef0123456789", issuedAt: t, expiresAt: t + 600000, username: "bob" });
  const s = w.sign(msg);
  assert.ok(SIG.verifySol(msg, s, w.address));
  assert.ok(SIG.verifySol(msg, SIG.b58encode(Buffer.from(s, "hex")), w.address));
  assert.ok(SIG.verifySol(msg, Buffer.from(s, "hex").toString("base64"), w.address));
  assert.ok(!SIG.verifySol(msg.replace("bob", "eve"), s, w.address));
  assert.ok(!SIG.verifySol(msg, s, solWallet().address));
  assert.equal(SIG.normSol("27uvb2S8ggJh2GVBsdMLX8m3nhZQnGrT22CZXbzDD1VC"), "27uvb2S8ggJh2GVBsdMLX8m3nhZQnGrT22CZXbzDD1VC");
  assert.equal(SIG.normSol("0OIl"), null);
  const k = Buffer.from("00010203", "hex");
  assert.deepEqual(SIG.b58decode(SIG.b58encode(k)), k);
});

// ── linking over HTTP ──
test("linking: off -> 404; signature required; nonce single-use + expiring; one account per wallet; several per account; unlink", async () => {
  const w = evmWallet("alice1");
  let r = await raw("POST", "/api/crypto/link/start", { user: "alice", body: { family: "evm", address: w.address } });
  assert.equal(r.status, 404, "off: no linking");
  await CP.set({ crypto_donations_enabled: true }, "test");
  assert.equal((await raw("POST", "/api/crypto/link/start", { body: { family: "evm", address: w.address } })).status, 401);
  assert.equal((await raw("POST", "/api/crypto/link/start", { user: "alice", body: { family: "evm", address: w.address }, headers: { Origin: "https://evil.example" } })).status, 403);
  // a typed address with a bad / someone else's signature is never linked
  const s1 = await raw("POST", "/api/crypto/link/start", { user: "alice", body: { family: "evm", address: w.address } });
  assert.match(s1.json.message, /Nonce: [0-9a-f]{24}\n/);
  const bad = await raw("POST", "/api/crypto/link/finish", { user: "alice", body: { nonce: s1.json.nonce, signature: evmWallet("x").sign(s1.json.message) } });
  assert.equal(bad.status, 400);
  const reuse = await raw("POST", "/api/crypto/link/finish", { user: "alice", body: { nonce: s1.json.nonce, signature: w.sign(s1.json.message) } });
  assert.equal(reuse.status, 400, "a nonce is single use, even after a failure");
  assert.match(reuse.json.error, /already used/);
  // expiry
  const s2 = await raw("POST", "/api/crypto/link/start", { user: "alice", body: { family: "evm", address: w.address } });
  t += 11 * 60 * 1000;
  assert.match((await raw("POST", "/api/crypto/link/finish", { user: "alice", body: { nonce: s2.json.nonce, signature: w.sign(s2.json.message) } })).json.error, /expired/);
  // another account can't finish my request
  const s3 = await raw("POST", "/api/crypto/link/start", { user: "alice", body: { family: "evm", address: w.address } });
  assert.equal((await raw("POST", "/api/crypto/link/finish", { user: "bob", body: { nonce: s3.json.nonce, signature: w.sign(s3.json.message) } })).status, 400);
  const ok = await raw("POST", "/api/crypto/link/finish", { user: "alice", body: { nonce: s3.json.nonce, signature: w.sign(s3.json.message) } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.address, SIG.toChecksum(w.address));
  const row = (await getQuery("SELECT * FROM crypto_wallets WHERE address = ?", [w.address]))[0];
  assert.equal(row.user_id, "u-alice"); assert.equal(row.link_source, "signature"); assert.equal(row.family, "evm");
  // the same wallet can't go to bob
  const sb = await raw("POST", "/api/crypto/link/start", { user: "bob", body: { family: "evm", address: w.address } });
  assert.equal(sb.status, 409);
  // several per account (an EVM + a Solana wallet)
  const sw = solWallet();
  const l2 = await link("alice", "sol", sw);
  assert.equal(l2.finish.status, 200, l2.finish.text);
  assert.equal((await CP.wallets("u-alice")).length, 2);
  // unlink (not someone else's)
  const ws = await CP.wallets("u-alice");
  assert.equal((await raw("POST", "/api/crypto/unlink", { user: "bob", body: { id: ws[1].id } })).status, 404);
  assert.equal((await raw("POST", "/api/crypto/unlink", { user: "alice", body: { id: ws[1].id } })).status, 200);
  assert.equal((await CP.wallets("u-alice")).length, 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM crypto_wallet_log WHERE action = 'unlink'"))[0].n, 1);
});

// ── the watcher: finality, reorgs, idempotency, crediting ──
test("EVM watcher: pending until finalized; a reorged-out transfer is dropped; credit = the donation mint, once", async () => {
  CP.set({ chain_sol: false, chain_base: false, max_usd: 1000, min_usd: 1 }, "test");
  const alice = (await CP.wallets("u-alice"))[0].address;
  CHAIN.eth = { head: 1000, final: 990, logs: [] };
  let r = await CP.pollOnce({ force: true });
  assert.equal(r.eth.last, 990, "the first scan starts at the finalized head");
  // a $5 transfer at 995: seen while not final -> pending, nothing credited
  CHAIN.eth.logs.push(logOf({ from: alice, block: 995, tx: "aa", li: 3, usd: 5 }));
  CHAIN.eth.head = 1005;
  await CP.pollOnce({ force: true });
  const idA = `eth:0x${"aa".padStart(64, "0")}:3`;
  assert.equal((await pay(idA)).status, "pending");
  assert.equal(await bal("alice"), 0);
  // a reorg: it lands again at 1001 with another log index; the old position is gone
  CHAIN.eth.logs = [logOf({ from: alice, block: 1001, tx: "aa", li: 1, usd: 5 })];
  CHAIN.eth.final = 1000; CHAIN.eth.head = 1012;
  await CP.pollOnce({ force: true });
  assert.equal((await pay(idA)).status, "dropped", "a pending transfer the finalized chain doesn't have is dropped");
  const idB = `eth:0x${"aa".padStart(64, "0")}:1`;
  assert.equal((await pay(idB)).status, "pending");
  CHAIN.eth.final = 1010;
  await CP.pollOnce({ force: true });
  const p = await pay(idB);
  assert.equal(p.status, "credited");
  assert.equal(p.pat, 2500000); assert.equal(p.bonus, 500000);
  assert.equal(await bal("alice"), 2500000);
  const c = await claims();
  assert.equal(c.length, 1);
  assert.equal(c[0].flow, "mint:donation"); assert.equal(c[0].type, "donation"); assert.equal(c[0].amount, 2500000);
  assert.equal(c[0].claimId, CP.claimIdOf(idB));
  assert.ok(c[0].claimId.length <= 56, "fits Pepe's claim id sanitizer");
  assert.deepEqual(JSON.parse(c[0].meta), { bonus: 500000, usd_cents: 500, rate: 500000, bonus_pct: 20, via: "crypto", chain: "eth", token: "USDC", tx: "0x" + "aa".padStart(64, "0"), idx: "1" });
  const tx = await getQuery("SELECT type, points FROM transactions WHERE userId = 'u-alice'");
  assert.deepEqual(tx.map((x) => [x.type, x.points]), [["donation-crypto", 2500000]]);
  // re-reading the same blocks (a restart that lost its cursor) changes nothing
  await runQuery("UPDATE crypto_cursors SET last_block = 980 WHERE chain = 'eth'");
  await CP.pollOnce({ force: true });
  assert.equal(await bal("alice"), 2500000);
  assert.equal((await claims()).length, 1);
  assert.equal((await CP.settle(idB)), "credited", "settling a credited payment again is a no-op");
  assert.equal((await claims()).length, 1);
  // the inbox notice
  const n = await getQuery("SELECT * FROM inbox WHERE userId = 'u-alice'").catch(() => []);
  if (n.length) assert.match(n[0].body, /5\.00 USDC received on Ethereum, 2,500,000 PAT added/);
});
test("Pepe's synced donation terms drive the amounts; dust is recorded, never credited", async () => {
  const alice = (await CP.wallets("u-alice"))[0].address;
  F.sync({ reserve: 1, monetary: { donation: { rate: 1000, bonus_pct: 50 } } });
  CHAIN.eth.logs.push(logOf({ from: alice, block: 1011, tx: "bb", li: 0, usd: 12.345678 }), logOf({ from: alice, block: 1011, tx: "bc", li: 0, usd: 0.99 }));
  CHAIN.eth.final = 1015; CHAIN.eth.head = 1020;
  await CP.pollOnce({ force: true });
  const p = await pay(`eth:0x${"bb".padStart(64, "0")}:0`);
  assert.equal(p.status, "credited"); assert.equal(p.usd_cents, 1234); assert.equal(p.pat, 12340); assert.equal(p.bonus, 6170);
  assert.equal((await pay(`eth:0x${"bc".padStart(64, "0")}:0`)).status, "dust");
  F.sync({ reserve: 1, monetary: { donation: { rate: 500000, bonus_pct: 20 } } });
});
test("unlinked sender -> unclaimed; credited when its owner links it by signature (never by a typed address)", async () => {
  const w = evmWallet("carol");
  CHAIN.eth.logs.push(logOf({ from: w.address, block: 1016, tx: "cc", li: 2, usd: 3 }));
  CHAIN.eth.final = 1020; CHAIN.eth.head = 1025;
  await CP.pollOnce({ force: true });
  const id = `eth:0x${"cc".padStart(64, "0")}:2`;
  assert.equal((await pay(id)).status, "unclaimed");
  assert.equal((await pay(id)).user_id, null);
  const l = await link("carol", "evm", w);
  assert.equal(l.finish.status, 200, l.finish.text);
  assert.deepEqual(l.finish.json.claimed, [{ id, status: "credited" }]);
  assert.equal(await bal("carol"), 1500000);
  assert.equal((await pay(id)).user_id, "u-carol");
});
test("over the per-transfer maximum -> held; an admin approves (credited) or rejects (nothing); admins only", async () => {
  const alice = (await CP.wallets("u-alice"))[0].address;
  await CP.set({ max_usd: 100 }, "test");
  CHAIN.eth.logs.push(logOf({ from: alice, block: 1021, tx: "dd", li: 0, usd: 150 }), logOf({ from: alice, block: 1021, tx: "de", li: 0, usd: 200 }));
  CHAIN.eth.final = 1025; CHAIN.eth.head = 1030;
  const before = await bal("alice");
  await CP.pollOnce({ force: true });
  const idD = `eth:0x${"dd".padStart(64, "0")}:0`, idE = `eth:0x${"de".padStart(64, "0")}:0`;
  assert.equal((await pay(idD)).status, "held");
  assert.equal(await bal("alice"), before);
  assert.equal((await raw("POST", "/api/crypto/admin/decide", { user: "alice", body: { id: idD, action: "approve" } })).status, 403);
  // owner answers 2026-10-20 (1): an Admin whose login is a Pepe ADMIN (not an owner) can't approve - nothing is credited
  await runQuery("UPDATE pepe_roles SET role = 'admin' WHERE login = 'boss_cf'");
  try {
    const no = await raw("POST", "/api/crypto/admin/decide", { user: "boss", body: { id: idD, action: "approve", note: "checked" } });
    assert.equal(no.status, 403, no.text);
    assert.match(no.json.error, /owners only/);
    assert.equal((await pay(idD)).status, "held");
    assert.equal(await bal("alice"), before);
  } finally {
    await runQuery("UPDATE pepe_roles SET role = 'owner' WHERE login = 'boss_cf'");
  }
  const a = await raw("POST", "/api/crypto/admin/decide", { user: "boss", body: { id: idD, action: "approve", note: "checked" } });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.status, "credited");
  assert.equal(await bal("alice"), before + 75000000);
  assert.equal((await pay(idD)).decided_by, "boss");
  const rj = await raw("POST", "/api/crypto/admin/decide", { user: "boss", body: { id: idE, action: "reject", note: "refund by hand" } });
  assert.equal(rj.json.status, "rejected");
  assert.equal(await bal("alice"), before + 75000000);
  assert.equal((await raw("POST", "/api/crypto/admin/decide", { user: "boss", body: { id: idE, action: "approve" } })).status, 409, "a rejected payment can't be approved later");
  await CP.set({ max_usd: 1000 }, "test");
});
test("Solana watcher: the wallet's token-account history before the first look is skipped; new finalized transfers credit", async () => {
  await CP.set({ chain_sol: true, chain_eth: false }, "test");
  const bob = solWallet();
  await link("bob", "sol", bob);
  const OWNER = CP.receiver("sol");
  const ACCT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";       // any valid base58 key stands in for the token account
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const mk = (sigName, amount, from, slot) => ({ slot, meta: { err: null, preTokenBalances: [{ accountIndex: 1, owner: from, mint }], postTokenBalances: [{ accountIndex: 1, owner: from, mint }, { accountIndex: 2, owner: OWNER, mint }], innerInstructions: [] },
    transaction: { message: { accountKeys: [{ pubkey: from }, { pubkey: "SRCacct1111111111111111111111111111111111111" }, { pubkey: ACCT }],
      instructions: [{ program: "spl-token", programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", parsed: { type: "transferChecked",
        info: { source: "SRCacct1111111111111111111111111111111111111", destination: ACCT, mint, authority: from, tokenAmount: { amount: String(amount), decimals: 6 } } } }] } } });
  CHAIN.sol = { slot: 5000, accounts: { [mint]: [ACCT] }, sigs: { [ACCT]: [{ signature: "old1", slot: 10, err: null }] }, txs: { old1: mk("old1", 9000000, bob.address, 10) } };
  await CP.pollOnce({ force: true });
  assert.equal(await pay("sol:old1:0"), undefined, "history from before the first look is never credited");
  CHAIN.sol.sigs[ACCT].push({ signature: "new1", slot: 20, err: null }, { signature: "fail1", slot: 21, err: { x: 1 } });
  CHAIN.sol.txs.new1 = mk("new1", 2000000, bob.address, 20);
  CHAIN.sol.slot = 5100;
  await CP.pollOnce({ force: true });
  const p = await pay("sol:new1:0");
  assert.equal(p.status, "credited"); assert.equal(p.token, "USDC"); assert.equal(p.chain, "sol");
  assert.equal(await bal("bob"), 1000000);
  await CP.pollOnce({ force: true });
  assert.equal(await bal("bob"), 1000000, "idempotent");
  assert.equal((await getQuery("SELECT last_sig FROM crypto_sol_cursors WHERE account = ?", [ACCT]))[0].last_sig, "fail1");
});
test("a transfer the independent verifier RPC doesn't confirm is SUSPECT (never credited) until an admin re-verifies it", async () => {
  await CP.set({ chain_sol: false, chain_eth: true }, "test");
  const alice = (await CP.wallets("u-alice"))[0].address;
  const before = await bal("alice");
  CHAIN.eth.logs.push(logOf({ from: alice, block: 1026, tx: "ee", li: 4, usd: 7 }));
  CHAIN.eth.final = 1030; CHAIN.eth.head = 1035;
  CHAIN.tamper = true;
  await CP.pollOnce({ force: true });
  const id = `eth:0x${"ee".padStart(64, "0")}:4`;
  assert.equal((await pay(id)).status, "suspect");
  assert.equal(await bal("alice"), before);
  await CP.pollOnce({ force: true });
  assert.equal((await pay(id)).status, "suspect", "suspect stays put (no automatic retry)");
  CHAIN.tamper = false;
  const r = await raw("POST", "/api/crypto/admin/decide", { user: "boss", body: { id, action: "reverify", note: "verifier was wrong" } });
  assert.equal(r.json.status, "credited", r.text);
  assert.equal(await bal("alice"), before + 3500000);
  // the verifier not having it yet = "verifying", retried next pass, no mint meanwhile
  CHAIN.eth.logs.push(logOf({ from: alice, block: 1031, tx: "ef", li: 0, usd: 2 }));
  CHAIN.eth.final = 1033; CHAIN.eth.head = 1036;
  const realFetch = mockFetch;
  CP._setFetch((url, opts) => (JSON.parse(opts.body).method === "eth_getTransactionReceipt" ? Promise.resolve({ ok: true, status: 200, json: async () => ({ result: null }) }) : realFetch(url, opts)));
  await CP.pollOnce({ force: true });
  const id2 = `eth:0x${"ef".padStart(64, "0")}:0`;
  assert.equal((await pay(id2)).status, "verifying");
  CP._setFetch(mockFetch);
  await CP.pollOnce({ force: true });
  assert.equal((await pay(id2)).status, "credited");
});
test("RPC failures back off per chain and show in health; the page + admin pages render", async () => {
  await CP.set({ chain_eth: true }, "test");
  CP._setFetch(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) }));
  const r = await CP.pollOnce({ force: true });
  assert.match(r.eth.error, /HTTP 503/);
  const h = await CP.health();
  const e = h.find((x) => x.chain === "eth");
  assert.equal(e.errors, 1); assert.ok(e.next_try > t);
  assert.equal(e.rpc.host, "ethereum-rpc.publicnode.com"); assert.equal(e.rpc.from_env, false);
  const r2 = await CP.pollOnce();
  assert.equal(r2.eth.skipped, "backoff");
  CP._setFetch(mockFetch);
  // settings refuse bad input
  await assert.rejects(CP.set({ addr_eth: "0x123" }, "test"), /valid EVM/);
  await assert.rejects(CP.set({ rpc_eth: "http://insecure.example" }, "test"), /https/);
  await assert.rejects(CP.set({ min_usd: 50, max_usd: 10 }, "test"), /maximum/);
  assert.equal(CP.get().addr_eth, "0xBD329B245135FCf5539F4D1eF40ba2D310E761A1");
});
test("pages: /support (QR codes, addresses, the viewer's payments) and /admin/crypto (admins only) render", async () => {
  await CP.set({ chain_sol: true, chain_eth: true, chain_base: true }, "test");
  const pg = await raw("GET", "/support", { user: "alice" });
  assert.equal(pg.status, 200, pg.text.slice(0, 400));
  assert.match(pg.text, /0xBD329B245135FCf5539F4D1eF40ba2D310E761A1/);
  assert.match(pg.text, /27uvb2S8ggJh2GVBsdMLX8m3nhZQnGrT22CZXbzDD1VC/);
  assert.match(pg.text, /<svg[^>]*>/, "QR codes inline");
  assert.match(pg.text, /data-crypto-link="evm"/);
  assert.match(pg.text, /id="cryptoPayments"/);
  assert.match(pg.text, /500,000/);
  const anon = await raw("GET", "/support");
  assert.equal(anon.status, 200);
  assert.doesNotMatch(anon.text, /id="cryptoPayments"/);
  assert.equal((await raw("GET", "/admin/crypto", { user: "alice" })).status, 302);
  const ad = await raw("GET", "/admin/crypto", { user: "boss" });
  assert.equal(ad.status, 200, ad.text.slice(0, 400));
  assert.match(ad.text, /Watcher/); assert.match(ad.text, /ethereum-rpc\.publicnode\.com/);
  await CP.set({ crypto_donations_enabled: false }, "test");
  assert.equal((await raw("GET", "/support", { user: "alice" })).status, 404, "off (and Stripe off): no page");
  assert.equal((await raw("GET", "/support", { user: "boss" })).status, 200, "admins get a preview");
});
