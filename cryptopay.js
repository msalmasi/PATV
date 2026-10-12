// cryptopay.js — 1.99ks: stablecoin donations (USDC / USDT on Ethereum, Base, Solana) that mint PAT, the same way a Stripe
// donation does (stripebilling.js, Economy v3 policy "donation"). Switch: crypto_donations_enabled (default OFF),
// independent of Stripe. Pages + routes: cryptoweb.js. Wallet-ownership proofs: cryptosig.js.
//
// RECEIVE ONLY. PATV never holds a key, never signs a transaction and never sends crypto anywhere: the receiving
// addresses are settings (public addresses the owner controls elsewhere) and this module only READS public chain data.
//
// How a donation is credited:
//   1. A member links a wallet (Edit profile -> Connections -> Crypto wallets) by SIGNING a message we wrote (nonce,
//      domain, expiry): EIP-4361 for EVM, signMessage for Solana. A typed address is never trusted (crypto_wallets,
//      link_source "signature"). One wallet = one PATV account; an account may link several; unlinking is allowed.
//   2. The watcher reads the receiving addresses' incoming token transfers (EVM: ERC-20 Transfer logs; Solana: the
//      receiving wallet's token accounts' transactions) and records each one ONCE under its idempotency key
//      chain:tx:logIndex (EVM) / sol:signature:instruction (Solana). Only FINAL transfers are credited: Ethereum /
//      Base = the "finalized" block tag (fallback: Ethereum 12 confirmations, Base "safe"); Solana = "finalized"
//      commitment. Seen-but-not-final EVM transfers show as "pending"; one that vanishes (a reorg) becomes "dropped".
//      Before anything mints, a SECOND, independent RPC (verify_rpc_*) must show the same final transfer (EVM: the receipt's
//      log at that index, same block, finalized there too; Solana: the finalized transaction parses the same) - else
//      "suspect" (never credited; an admin can re-verify). Can't tell yet (verifier lagging / down) = "verifying", retried.
//   3. A final transfer is: dust (under min_usd; recorded, never credited), unclaimed (the sender isn't a linked
//      wallet - credited automatically when someone links it with a valid signature), held (over max_usd - an admin
//      approves or rejects it on /admin/crypto) or credited.
//   4. Credit = exactly the Stripe donation mint: pat = floor(usd_cents * donation_rate / 100), bonus = floor(pat *
//      donation_bonus_pct / 100) (Pepe's monetary.donation, synced), a "donation-crypto" transactions row and a
//      "mint:donation" reserve_claims row with meta {bonus, usd_cents, rate, bonus_pct, via:"crypto", chain, token, tx},
//      in ONE transaction with the payment row's status change. Pepe journals the mint (policy donation: outside the
//      monthly caps, in the Fed mint log + supply history) and mints the bonus into the incentive budget. Donated PAT
//      is purchased PAT: there is no cash-out.
//
// Settings (crypto_settings, key -> JSON; /admin/crypto): see DEFAULTS. RPC endpoints: env CRYPTO_RPC_ETH / _BASE / _SOL
// (may carry a provider key - never shown, never logged) override the admin-set public URLs.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const sig = require("./cryptosig");

// ── the REVIEWED token table (never inferred from a transfer) ──
// USDC: Circle, "USDC Contract Addresses" - https://developers.circle.com/stablecoins/usdc-contract-addresses
//   (checked 2026-10-10: Ethereum 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, Base 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
//    Solana EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
// USDT: Tether, "Supported Protocols" - https://tether.to/en/supported-protocols/
//   (checked 2026-10-10: Ethereum 0xdac17f958d2ee523a2206206994597c13d831ec7, Solana Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB;
//    Base is NOT a Tether-supported protocol, so there is no USDT on Base here - bridged "USDT" tokens there are not Tether's)
// All four are 6-decimal tokens (decimals() / the mint's decimals checked on mainnet by tools/crypto-dryrun.js).
const TOKENS = Object.freeze({
  eth: Object.freeze({
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": Object.freeze({ symbol: "USDC", decimals: 6 }),
    "0xdac17f958d2ee523a2206206994597c13d831ec7": Object.freeze({ symbol: "USDT", decimals: 6 }),
  }),
  base: Object.freeze({
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": Object.freeze({ symbol: "USDC", decimals: 6 }),
  }),
  sol: Object.freeze({
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": Object.freeze({ symbol: "USDC", decimals: 6 }),
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": Object.freeze({ symbol: "USDT", decimals: 6 }),
  }),
});
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";   // keccak("Transfer(address,address,uint256)")
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const CHAINS = Object.freeze({
  eth: { id: "eth", family: "evm", name: "Ethereum", chainId: 1, explorer: "https://etherscan.io/tx/", chunk: 1000, maxChunks: 20,
         rpc: "https://ethereum-rpc.publicnode.com", env: "CRYPTO_RPC_ETH", verify: "https://eth.drpc.org", verifyEnv: "CRYPTO_VERIFY_RPC_ETH",
         fallback: { confirmations: 12 } },
  base: { id: "base", family: "evm", name: "Base", chainId: 8453, explorer: "https://basescan.org/tx/", chunk: 2000, maxChunks: 20,
          rpc: "https://base-rpc.publicnode.com", env: "CRYPTO_RPC_BASE", verify: "https://mainnet.base.org", verifyEnv: "CRYPTO_VERIFY_RPC_BASE",
          fallback: { tag: "safe" } },
  sol: { id: "sol", family: "sol", name: "Solana", explorer: "https://solscan.io/tx/", rpc: "https://api.mainnet-beta.solana.com", env: "CRYPTO_RPC_SOL",
         verify: "https://solana-rpc.publicnode.com", verifyEnv: "CRYPTO_VERIFY_RPC_SOL" },
});
const CHAIN_IDS = Object.keys(CHAINS);

// ── settings ──
const DEFAULTS = {
  crypto_donations_enabled: false,     // the whole feature (page, linking, watcher); independent of Stripe
  watch_when_off: false,               // run the watcher (record only) while the feature is off - for testing
  chain_eth: true, chain_base: true, chain_sol: true,
  // the receiving addresses (public; receive-only - nobody at PATV holds a key here)
  addr_eth: "0xBD329B245135FCf5539F4D1eF40ba2D310E761A1",
  addr_base: "0xBD329B245135FCf5539F4D1eF40ba2D310E761A1",
  addr_sol: "27uvb2S8ggJh2GVBsdMLX8m3nhZQnGrT22CZXbzDD1VC",
  min_usd: 1,                          // under it = dust: recorded, never credited
  max_usd: 1000,                       // over it (per transfer) = held for an admin
  poll_sec: 60,
  // public RPC endpoints (no keys here - a keyed URL goes in the env: CRYPTO_RPC_ETH / _BASE / _SOL)
  rpc_eth: CHAINS.eth.rpc, rpc_base: CHAINS.base.rpc, rpc_sol: CHAINS.sol.rpc,
  // a SECOND, independent provider re-reads every final transfer before it can mint (a lying / broken RPC can't mint PAT);
  // a mismatch = "suspect" (never credited; an admin can re-verify). Env CRYPTO_VERIFY_RPC_ETH / _BASE / _SOL override.
  verify_payments: true,
  verify_rpc_eth: CHAINS.eth.verify, verify_rpc_base: CHAINS.base.verify, verify_rpc_sol: CHAINS.sol.verify,
  start_lookback_blocks: 0,            // where a chain's first scan starts: the finalized head minus this
  link_max_wallets: 10,
};
const S = JSON.parse(JSON.stringify(DEFAULTS));
const num = (v, lo, hi, d) => { const n = Math.floor(Number(String(v == null ? "" : v).replace(/[, _$]/g, ""))); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const bool = (v) => v === true || v === 1 || v === "1" || v === "on" || v === "true";
const refuse = (status, message) => Object.assign(new Error(message), { status, refuse: true });
function httpsUrl(v, d) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return d;
  try { const u = new URL(s); if (u.protocol !== "https:" || u.username || u.password) throw 0; return u.toString().replace(/\/$/, ""); } catch (e) {
    throw refuse(400, "An RPC endpoint must be an https:// URL (put keyed URLs in the server's .env instead).");
  }
}
function addr(family) {
  return (v) => {
    const s = String(v == null ? "" : v).trim();
    const n = sig.norm(family, s);
    if (!n) throw refuse(400, `That isn't a valid ${family === "evm" ? "EVM" : "Solana"} address.`);
    return family === "evm" ? sig.toChecksum(n) : n;
  };
}
const CLEAN = {
  crypto_donations_enabled: bool, watch_when_off: bool, chain_eth: bool, chain_base: bool, chain_sol: bool,
  addr_eth: addr("evm"), addr_base: addr("evm"), addr_sol: addr("sol"),
  min_usd: (v) => num(v, 1, 1000, 1),
  max_usd: (v) => num(v, 1, 1000000, 1000),
  poll_sec: (v) => num(v, 20, 3600, 60),
  rpc_eth: (v) => httpsUrl(v, CHAINS.eth.rpc), rpc_base: (v) => httpsUrl(v, CHAINS.base.rpc), rpc_sol: (v) => httpsUrl(v, CHAINS.sol.rpc),
  verify_payments: bool,
  verify_rpc_eth: (v) => httpsUrl(v, CHAINS.eth.verify), verify_rpc_base: (v) => httpsUrl(v, CHAINS.base.verify), verify_rpc_sol: (v) => httpsUrl(v, CHAINS.sol.verify),
  start_lookback_blocks: (v) => num(v, 0, 100000, 0),
  link_max_wallets: (v) => num(v, 1, 50, 10),
};

let clock = () => Date.now();
let fetchImpl = (...a) => fetch(...a);
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS crypto_settings (key TEXT PRIMARY KEY, value TEXT)");
      // a proven wallet link: one wallet (family + address) -> one account
      await runQuery(`CREATE TABLE IF NOT EXISTS crypto_wallets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
        family TEXT NOT NULL, address TEXT NOT NULL, link_source TEXT NOT NULL DEFAULT 'signature', message TEXT, signature TEXT,
        created INTEGER NOT NULL, UNIQUE (family, address))`);
      await runQuery("CREATE INDEX IF NOT EXISTS crypto_wallets_user ON crypto_wallets (user_id)");
      await runQuery(`CREATE TABLE IF NOT EXISTS crypto_link_nonces (nonce TEXT PRIMARY KEY, user_id TEXT NOT NULL, family TEXT NOT NULL,
        address TEXT NOT NULL, message TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, used INTEGER)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS crypto_wallet_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, family TEXT,
        address TEXT, action TEXT, actor TEXT, at INTEGER NOT NULL)`);
      // every incoming stablecoin transfer we've seen (id = the idempotency key)
      await runQuery(`CREATE TABLE IF NOT EXISTS crypto_payments (id TEXT PRIMARY KEY, chain TEXT NOT NULL, token TEXT NOT NULL,
        token_addr TEXT NOT NULL, tx TEXT NOT NULL, idx TEXT NOT NULL, block INTEGER, src_addr TEXT NOT NULL, dst_addr TEXT NOT NULL, dst_acct TEXT,
        raw_amount TEXT NOT NULL, usd_cents INTEGER NOT NULL, status TEXT NOT NULL, user_id TEXT, pat INTEGER, bonus INTEGER,
        claim_id TEXT, seen INTEGER NOT NULL, final_at INTEGER, credited_at INTEGER, decided_by TEXT, note TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS crypto_payments_status ON crypto_payments (status, seen)");
      await runQuery("CREATE INDEX IF NOT EXISTS crypto_payments_src ON crypto_payments (src_addr)");
      await runQuery("CREATE INDEX IF NOT EXISTS crypto_payments_user ON crypto_payments (user_id)");
      // 1.99ts: why a payment is held: "max" (over max_usd) or "daily_limit" (over the member's daily donation limit)
      const pc = (await getQuery("SELECT name FROM pragma_table_info('crypto_payments')")).map((r) => r.name);
      if (!pc.includes("hold_reason")) await runQuery("ALTER TABLE crypto_payments ADD COLUMN hold_reason TEXT");
      // watcher state per chain (EVM: last finalized block fully scanned; Solana: per token account in crypto_sol_cursors)
      await runQuery(`CREATE TABLE IF NOT EXISTS crypto_cursors (chain TEXT PRIMARY KEY, last_block INTEGER, head INTEGER, final_head INTEGER,
        recv TEXT, last_ok INTEGER, last_error TEXT, last_error_at INTEGER, errors INTEGER DEFAULT 0, next_try INTEGER DEFAULT 0)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS crypto_sol_cursors (account TEXT PRIMARY KEY, mint TEXT NOT NULL, recv TEXT NOT NULL,
        last_sig TEXT, last_slot INTEGER, updated INTEGER)`);
      await loadSettings();
      await require("./funding").init();          // reserve_claims (+ meta)
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
/** (Re)read the saved settings. The watcher's tick does it too, so tools/crypto-settings.js applies without a restart. */
async function loadSettings() {
  for (const r of await getQuery("SELECT key, value FROM crypto_settings")) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, r.key)) continue;
    try { S[r.key] = JSON.parse(r.value); } catch (e) { /* keep the default */ }
  }
}
const get = () => JSON.parse(JSON.stringify(S));
const enabled = () => !!S.crypto_donations_enabled;
async function set(patch, actor) {
  await init();
  const p = { ...(patch || {}) };
  for (const b of [].concat(p._bools || [])) if (!(b in p) && CLEAN[b] === bool) p[b] = false;
  const next = {};
  for (const [k, v] of Object.entries(p)) if (Object.prototype.hasOwnProperty.call(CLEAN, k)) next[k] = CLEAN[k](v);   // validate all first
  if ("min_usd" in next || "max_usd" in next) {
    const lo = "min_usd" in next ? next.min_usd : S.min_usd, hi = "max_usd" in next ? next.max_usd : S.max_usd;
    if (hi < lo) throw refuse(400, "The per-transfer maximum can't be under the minimum.");
  }
  const changed = [];
  for (const [k, val] of Object.entries(next)) {
    if (JSON.stringify(val) === JSON.stringify(S[k])) continue;
    S[k] = val;
    await runQuery("INSERT INTO crypto_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, JSON.stringify(val)]);
    changed.push(k);
  }
  if (changed.length) console.log(`[crypto] settings changed by ${actor || "?"}: ${changed.join(", ")}`);
  if (changed.some((k) => k === "crypto_donations_enabled" || k === "watch_when_off" || k === "poll_sec")) kick();
  return { settings: get(), changed };
}
const env = (k) => String(process.env[k] || "").trim();
const rpcUrl = (chain) => env(CHAINS[chain].env) || S["rpc_" + chain] || CHAINS[chain].rpc;
const verifyUrl = (chain) => env(CHAINS[chain].verifyEnv) || S["verify_rpc_" + chain] || CHAINS[chain].verify;
/** What the admin page may show about an endpoint: the host + whether it came from the env (never the path / key). */
function rpcInfo(chain, which = "rpc") {
  const fromEnv = !!env(which === "verify" ? CHAINS[chain].verifyEnv : CHAINS[chain].env);
  let host = "?";
  try { host = new URL(which === "verify" ? verifyUrl(chain) : rpcUrl(chain)).host; } catch (e) { /* bad url */ }
  return { host, from_env: fromEnv };
}
const receiver = (chain) => (CHAINS[chain].family === "evm" ? sig.normEvm(S["addr_" + chain]) : sig.normSol(S.addr_sol));
const chainOn = (chain) => !!S["chain_" + chain] && !!receiver(chain);
/** The accepted chains + tokens + addresses, for the page. */
function accepted() {
  return CHAIN_IDS.filter(chainOn).map((c) => ({
    chain: c, name: CHAINS[c].name, family: CHAINS[c].family,
    address: CHAINS[c].family === "evm" ? sig.toChecksum(S["addr_" + c]) : S.addr_sol,
    tokens: Object.entries(TOKENS[c]).map(([a, t]) => ({ symbol: t.symbol, address: CHAINS[c].family === "evm" ? sig.toChecksum(a) : a })),
  }));
}

// ── amounts ──
/** USD cents for a raw token amount (face value; floor). */
function centsOf(raw, decimals) {
  let n;
  try { n = BigInt(String(raw)); } catch (e) { return 0; }
  if (n <= 0n) return 0;
  const c = decimals >= 2 ? n / 10n ** BigInt(decimals - 2) : n * 10n ** BigInt(2 - decimals);
  return c > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(c);
}
const usd = (cents) => (Number(cents) / 100).toFixed(2);
function terms() { return require("./funding").donationTerms(); }
function patFor(cents) {
  const T = terms();
  const pat = Math.floor((Number(cents) * T.rate) / 100);
  return { pat, bonus: Math.floor((pat * T.bonus_pct) / 100), rate: T.rate, bonus_pct: T.bonus_pct };
}
/** What a FINAL transfer becomes. linked = the account its sender wallet is linked to (or null). */
function classify(cents, linked, o = S) {
  if (cents < Number(o.min_usd) * 100) return "dust";
  if (!linked) return "unclaimed";
  if (cents > Number(o.max_usd) * 100) return "held";
  return "credit";
}

// ── parsing (pure: tested against recorded RPC fixtures) ──
const hexNum = (h) => (typeof h === "number" ? h : parseInt(String(h || "0"), 16));
const topicAddr = (t) => (/^0x0{24}[0-9a-fA-F]{40}$/.test(String(t || "")) ? "0x" + String(t).slice(26).toLowerCase() : null);
/** ERC-20 Transfer logs (eth_getLogs results) -> transfers to `recv` of a REVIEWED token on `chain`. */
function parseEvmLogs(chain, logs, recv) {
  const out = [];
  const want = sig.normEvm(recv);
  for (const l of logs || []) {
    if (!l || l.removed) continue;
    const token = String(l.address || "").toLowerCase();
    const T = TOKENS[chain] && TOKENS[chain][token];
    if (!T) continue;
    const tp = l.topics || [];
    if (String(tp[0] || "").toLowerCase() !== TRANSFER_TOPIC || tp.length !== 3) continue;
    const from = topicAddr(tp[1]), to = topicAddr(tp[2]);
    if (!from || !to || to !== want) continue;
    const data = String(l.data || "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(data)) continue;
    const raw = BigInt(data).toString();
    const tx = String(l.transactionHash || "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(tx)) continue;
    const li = hexNum(l.logIndex);
    out.push({ id: `${chain}:${tx}:${li}`, chain, token: T.symbol, token_addr: token, tx, idx: String(li), block: hexNum(l.blockNumber),
               src_addr: from, dst_addr: to, raw_amount: raw, usd_cents: centsOf(raw, T.decimals) });
  }
  return out;
}
/**
 * One finalized Solana transaction (getTransaction, encoding jsonParsed) -> SPL-token transfers INTO `account` (a token
 * account of `owner` for `mint`). Outer instruction i -> idx "i", inner j of outer i -> "i.j". The sender is the source
 * token account's OWNER (from the token balances), else the signing authority.
 */
function parseSolTx(sigStr, txr, account, mint, owner) {
  const out = [];
  if (!txr || !txr.meta || txr.meta.err) return out;
  const T = TOKENS.sol[mint];
  if (!T) return out;
  const keys = ((txr.transaction && txr.transaction.message && txr.transaction.message.accountKeys) || []).map((k) => (typeof k === "string" ? k : k && k.pubkey));
  const owners = {};
  for (const b of [].concat(txr.meta.preTokenBalances || [], txr.meta.postTokenBalances || [])) {
    if (b && keys[b.accountIndex] && b.owner) owners[keys[b.accountIndex]] = { owner: b.owner, mint: b.mint };
  }
  const look = (ix, idx) => {
    if (!ix || !ix.parsed || typeof ix.parsed !== "object") return;
    if (ix.program !== "spl-token" && ix.programId !== SPL_TOKEN_PROGRAM) return;
    const ty = ix.parsed.type, info = ix.parsed.info || {};
    if (ty !== "transfer" && ty !== "transferChecked") return;
    if (info.destination !== account) return;
    if (ty === "transferChecked" && info.mint !== mint) return;
    const raw = ty === "transferChecked" ? (info.tokenAmount && info.tokenAmount.amount) : info.amount;
    if (!/^\d+$/.test(String(raw || ""))) return;
    if (ty === "transferChecked" && info.tokenAmount && Number(info.tokenAmount.decimals) !== T.decimals) return;
    const srcInfo = owners[info.source];
    if (srcInfo && srcInfo.mint && srcInfo.mint !== mint) return;
    const from = (srcInfo && srcInfo.owner) || info.authority || info.multisigAuthority || null;
    if (!from || !sig.normSol(from)) return;
    out.push({ id: `sol:${sigStr}:${idx}`, chain: "sol", token: T.symbol, token_addr: mint, tx: sigStr, idx: String(idx), block: Number(txr.slot) || null,
               src_addr: from, dst_addr: owner, dst_acct: account, raw_amount: String(raw), usd_cents: centsOf(raw, T.decimals) });
  };
  const outer = (txr.transaction && txr.transaction.message && txr.transaction.message.instructions) || [];
  outer.forEach((ix, i) => look(ix, String(i)));
  for (const g of txr.meta.innerInstructions || []) {
    (g.instructions || []).forEach((ix, j) => look(ix, `${g.index}.${j}`));
  }
  return out;
}

// ── RPC ──
async function rpc(chain, method, params, { timeout = 20000, url = null } = {}) {
  const r = await fetchImpl(url || rpcUrl(chain), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeout) });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok || !j) throw Object.assign(new Error(`${CHAINS[chain].name} RPC ${method}: HTTP ${r.status}`), { rpc: true });
  if (j.error) throw Object.assign(new Error(`${CHAINS[chain].name} RPC ${method}: ${String(j.error.message || j.error.code || "error").slice(0, 160)}`), { rpc: true, code: j.error.code });
  return j.result;
}
/** The EVM finalized head (block number), with the chain's fallback. -> {head, final, how} */
async function evmHeads(chain, url = null) {
  const head = hexNum(await rpc(chain, "eth_blockNumber", [], { url }));
  let final = null, how = "finalized";
  try { const b = await rpc(chain, "eth_getBlockByNumber", ["finalized", false], { url }); if (b && b.number) final = hexNum(b.number); } catch (e) { final = null; }
  if (final == null) {
    const fb = CHAINS[chain].fallback || {};
    if (fb.tag) {
      const b = await rpc(chain, "eth_getBlockByNumber", [fb.tag, false], { url });
      if (!b || !b.number) throw new Error(`${CHAINS[chain].name}: no ${fb.tag} head`);
      final = hexNum(b.number); how = fb.tag;
    } else { final = head - (fb.confirmations || 12); how = `${fb.confirmations || 12} confirmations`; }
  }
  return { head, final: Math.min(final, head), how };
}
async function evmLogs(chain, from, to, recv) {
  const topicTo = "0x" + "0".repeat(24) + sig.normEvm(recv).slice(2);
  const logs = await rpc(chain, "eth_getLogs", [{ fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
    address: Object.keys(TOKENS[chain]), topics: [TRANSFER_TOPIC, null, topicTo] }]);
  return parseEvmLogs(chain, logs, recv);
}
async function solAccounts(owner) {
  const out = [];
  for (const mint of Object.keys(TOKENS.sol)) {
    const r = await rpc("sol", "getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "finalized" }]);
    for (const a of (r && r.value) || []) {
      const info = a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info;
      if (!info || info.mint !== mint || info.owner !== owner) continue;          // only what the chain says is ours
      out.push({ account: a.pubkey, mint });
    }
  }
  return out;
}
/** Finalized signatures for `account` newer than `until` (oldest first). */
async function solSignatures(account, until, { limit = 1000, maxPages = 5 } = {}) {
  const all = [];
  let before;
  for (let p = 0; p < maxPages; p++) {
    const opt = { limit, commitment: "finalized" };
    if (until) opt.until = until;
    if (before) opt.before = before;
    const page = (await rpc("sol", "getSignaturesForAddress", [account, opt])) || [];
    all.push(...page);
    if (page.length < limit) break;
    before = page[page.length - 1].signature;
  }
  return all.reverse();
}
async function solTx(s) {
  return rpc("sol", "getTransaction", [s, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
}

// ── wallets ──
async function walletOwner(family, address) {
  const a = sig.norm(family, address);
  if (!a) return null;
  const r = await getQuery("SELECT user_id FROM crypto_wallets WHERE family = ? AND address = ?", [family, a]);
  return r.length ? r[0].user_id : null;
}
const familyOf = (chain) => CHAINS[chain].family;
async function wallets(userId) {
  await init();
  return getQuery("SELECT id, family, address, link_source, created FROM crypto_wallets WHERE user_id = ? ORDER BY created", [userId]);
}

// ── recording + crediting ──
const tx = (fn) => require("./boosts").tx(fn);
const claimIdOf = (id) => "cdon-" + crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 40);
/**
 * Record a transfer. final=false -> "pending" (EVM, not yet final). A final one goes "verifying" -> (the second provider
 * agrees) "final" -> settle(), or "suspect". Returns the row's status after.
 */
async function record(t, final) {
  const now = clock();
  const ex = (await getQuery("SELECT status FROM crypto_payments WHERE id = ?", [t.id]))[0];
  if (!ex) {
    const linked = await walletOwner(familyOf(t.chain), t.src_addr);
    await runQuery(`INSERT OR IGNORE INTO crypto_payments (id, chain, token, token_addr, tx, idx, block, src_addr, dst_addr, dst_acct, raw_amount,
      usd_cents, status, user_id, seen, final_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [t.id, t.chain, t.token, t.token_addr, t.tx, t.idx, t.block, t.src_addr, t.dst_addr, t.dst_acct || null, t.raw_amount, t.usd_cents,
       final ? "verifying" : "pending", linked, now, final ? now : null]);
  } else if (final && (ex.status === "pending" || ex.status === "dropped")) {
    await runQuery("UPDATE crypto_payments SET status = 'verifying', block = ?, final_at = ? WHERE id = ? AND status IN ('pending', 'dropped')", [t.block, now, t.id]);
  }
  if (final) return verifyAndSettle(t.id);
  return ex ? ex.status : "pending";
}
/** Does the independent verifier RPC show exactly this FINAL transfer? true / false (mismatch); throws = can't tell yet. */
async function confirm(p) {
  if (!S.verify_payments) return true;
  const url = verifyUrl(p.chain);
  if (CHAINS[p.chain].family === "evm") {
    const rc = await rpc(p.chain, "eth_getTransactionReceipt", [p.tx], { url });
    if (!rc) throw new Error("the verifier doesn't have the transaction yet");
    if (String(rc.status) !== "0x1") return false;
    const log = (rc.logs || []).find((l) => hexNum(l.logIndex) === Number(p.idx));
    const x = log ? parseEvmLogs(p.chain, [{ ...log, transactionHash: log.transactionHash || p.tx }], p.dst_addr)[0] : null;
    if (!x || x.id !== p.id || x.raw_amount !== p.raw_amount || x.src_addr !== p.src_addr || x.token_addr !== p.token_addr) return false;
    if (hexNum(rc.blockNumber) !== Number(p.block)) return false;
    const h = await evmHeads(p.chain, url);
    if (hexNum(rc.blockNumber) > h.final) throw new Error("not final on the verifier yet");
    return true;
  }
  const txr = await rpc("sol", "getTransaction", [p.tx, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }], { url });
  if (!txr) throw new Error("the verifier doesn't have the transaction (finalized) yet");
  const x = parseSolTx(p.tx, txr, p.dst_acct, p.token_addr, p.dst_addr).find((y) => y.id === p.id);
  return !!x && x.raw_amount === p.raw_amount && x.src_addr === p.src_addr;
}
async function verifyAndSettle(id) {
  const p = (await getQuery("SELECT * FROM crypto_payments WHERE id = ?", [id]))[0];
  if (!p) return null;
  if (p.status === "verifying") {
    let ok;
    try { ok = await confirm(p); } catch (e) {
      console.warn(`[crypto] verify ${id}: ${String(e.message).replace(/https?:\/\/\S+/g, "<url>").slice(0, 160)} - retried next pass`);
      return "verifying";
    }
    if (!ok) {
      await runQuery("UPDATE crypto_payments SET status = 'suspect' WHERE id = ? AND status = 'verifying'", [id]);
      console.error(`[crypto] SUSPECT ${id}: the verifier RPC doesn't show this transfer as reported - NOT credited (check /admin/crypto)`);
      return "suspect";
    }
    await runQuery("UPDATE crypto_payments SET status = 'final' WHERE id = ? AND status = 'verifying'", [id]);
  }
  try { return await settle(id); } catch (e) {
    console.error(`[crypto] settle ${id}: ${e.message} - left final, retried next pass`);   // never blocks the scan
    return "final";
  }
}
/**
 * Decide a FINAL payment (status final / unclaimed; held only with force). Credits it when its sender is linked.
 * opts: force (an admin approved an over-limit one), actor. -> the new status.
 */
async function settle(id, { force = false, actor = null } = {}) {
  await init();
  await require("./donationpromo").init();     // 1.99tq: before the transaction (never a memoized init inside one)
  let notice = null;
  const status = await tx(async () => {
    const p = (await getQuery("SELECT * FROM crypto_payments WHERE id = ?", [id]))[0];
    if (!p) return null;
    const open = ["final", "unclaimed"].concat(force ? ["held"] : []);
    if (!open.includes(p.status)) return p.status;
    const ledger = require("./ledger");
    let owner = await walletOwner(familyOf(p.chain), p.src_addr);
    if (owner) owner = await ledger.resolveUserId(owner);
    let c = classify(p.usd_cents, owner);
    if (force && c === "held") c = "credit";
    if (c !== "credit") {
      await runQuery("UPDATE crypto_payments SET status = ?, user_id = ?, hold_reason = ? WHERE id = ?", [c, owner || null, c === "held" ? "max" : null, id]);
      if (c === "held" && p.status !== "held") notice = { kind: "held", userId: owner, p };
      return c;
    }
    // 1.99ts: over the member's daily donation limit (the day it was SEEN) -> held for review, never silently refused: an admin
    // credits it (at the terms of the moment it was seen) or marks it refunded off-site. An admin approval (force) skips this.
    if (!force) {
      const L = await require("./donationpromo").limitCheck(owner, p.usd_cents, Number(p.seen));
      if (L.over) {
        await runQuery("UPDATE crypto_payments SET status = 'held', user_id = ?, hold_reason = 'daily_limit' WHERE id = ?", [owner, id]);
        notice = { kind: "held_limit", userId: owner, p, limit: L.limit_cents, used: L.used_cents };
        console.log(`[crypto] ${id}: ${usd(p.usd_cents)} would take ${owner} over the daily donation limit ($${usd(L.used_cents)} of $${usd(L.limit_cents)} used) - held for review`);
        return "held";
      }
    }
    const cid = claimIdOf(id);
    // 1.99tq: THE shared donation credit (donationpromo.creditTerms - the card rail calls the same): the normal rate, or a live
    // donation promo's split. Paid = when the watcher first saw the transfer (a wallet linked later still gets its moment's terms).
    const DP = require("./donationpromo");
    if (Math.floor((Number(p.usd_cents) * terms().rate) / 100) <= 0) { await runQuery("UPDATE crypto_payments SET status = 'dust', user_id = ? WHERE id = ?", [owner, id]); return "dust"; }
    const T = await DP.creditTerms({ ref: cid, userId: owner, cents: p.usd_cents, paidAt: Number(p.seen), via: "crypto" });
    await DP.recordCredit({ ref: cid, userId: owner, via: "crypto", paidAt: Number(p.seen), cents: p.usd_cents });   // 1.99ts: the day's limit
    await ledger.postOrThrow(owner, T.pat, "donation-crypto", { transactionId: cid, source: "crypto donation", note: DP.noteOf(T) });
    await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, meta) VALUES (?, 'mint:donation', ?, 'donation', ?, ?)",
      [cid, owner, T.pat, JSON.stringify({ bonus: T.bonus, usd_cents: p.usd_cents, rate: T.rate, bonus_pct: T.bonus_pct, via: "crypto",
                                           chain: p.chain, token: p.token, tx: p.tx, idx: p.idx, ...DP.metaOf(T) })]);
    await runQuery(`UPDATE crypto_payments SET status = 'credited', user_id = ?, pat = ?, bonus = ?, claim_id = ?, credited_at = ?, decided_by = ?
                    WHERE id = ?`, [owner, T.pat, T.bonus, cid, clock(), actor, id]);
    console.log(`[crypto] donation ${id}: ${usd(p.usd_cents)} ${p.token} on ${CHAINS[p.chain].name} -> ${T.pat} PAT for ${owner} (+${T.bonus} to the incentive budget; mint claim ${cid})${actor ? " approved by " + actor : ""}`);
    notice = { kind: "credited", userId: owner, p, pat: T.pat, terms: T };
    return "credited";
  });
  if (notice) await notify(notice);
  if (notice && notice.kind === "credited") { try { require("./supporter").onDonation(notice.userId).catch(() => {}); } catch (e) { /* never blocks */ } }   // 1.99mv: 💚 Supporter perks + achievements
  return status;
}
async function notify(n) {
  if (!n.userId) return;
  try {
    const i18n = require("./i18n");
    await i18n.ensure();
    const t = i18n.tFor(i18n.getPref(n.userId) || "en");
    const fmt = (x) => (t.num ? t.num(x) : Number(x).toLocaleString("en-US"));
    const amount = usd(n.p.usd_cents);
    if (n.kind === "credited") {
      await require("./inbox").addSafe(n.userId, { kind: "system", ref: "cdon-" + n.p.id.slice(0, 120), link: "/support",
        title: t("donate.notice_title"), body: t("crypto.notice_body", { amount, token: n.p.token, chain: CHAINS[n.p.chain].name, pat: fmt(n.pat) }) +
          require("./donationpromo").receiptLine(t, n.terms) });
    } else if (n.kind === "held") {
      await require("./inbox").addSafe(n.userId, { kind: "system", ref: "cheld-" + n.p.id.slice(0, 120), link: "/support",
        title: t("donate.notice_title"), body: t("crypto.notice_held", { amount, token: n.p.token, max: fmt(S.max_usd) }) });
    } else if (n.kind === "held_limit") {
      // 1.99ts: over the member's daily donation limit - held for an admin, explained
      await require("./inbox").addSafe(n.userId, { kind: "system", ref: "climit-" + n.p.id.slice(0, 120), link: "/support",
        title: t("donate.notice_title"), body: t("crypto.notice_held_limit", { amount, token: n.p.token, limit: usd(n.limit), used: usd(n.used) }) });
    } else if (n.kind === "refunded") {
      await require("./inbox").addSafe(n.userId, { kind: "system", ref: "crefund-" + n.p.id.slice(0, 120), link: "/support",
        title: t("donate.notice_title"), body: t("crypto.notice_refunded", { amount, token: n.p.token, chain: CHAINS[n.p.chain].name }) });
    }
  } catch (e) { /* notice only */ }
}
/** Credit what a newly linked wallet sent before it was linked. */
async function claimUnclaimed(family, address) {
  const a = sig.norm(family, address);
  const chains = CHAIN_IDS.filter((c) => CHAINS[c].family === family);
  const rows = await getQuery(`SELECT id FROM crypto_payments WHERE status = 'unclaimed' AND src_addr = ? AND chain IN (${chains.map(() => "?").join(",")})`, [a, ...chains]);
  const out = [];
  for (const r of rows) out.push({ id: r.id, status: await settle(r.id) });
  return out;
}
/** Admin: approve (credit) or reject a held payment; ignore an unclaimed one. */
async function decide(id, action, actor, note) {
  await init();
  const p = (await getQuery("SELECT * FROM crypto_payments WHERE id = ?", [id]))[0];
  if (!p) throw refuse(404, "No such payment.");
  const why = String(note || "").slice(0, 300) || null;
  if (action === "approve") {
    if (p.status !== "held") throw refuse(409, `It is ${p.status}, not held.`);
    const st = await settle(id, { force: true, actor });
    if (why) await runQuery("UPDATE crypto_payments SET note = ? WHERE id = ?", [why, id]);
    return { status: st };
  }
  if (action === "reject" || action === "ignore") {
    const from = action === "reject" ? "held" : "unclaimed";
    const to = action === "reject" ? "rejected" : "ignored";
    const r = await runQuery("UPDATE crypto_payments SET status = ?, decided_by = ?, note = ? WHERE id = ? AND status = ?", [to, actor, why, id, from]);
    if (!r.changes) throw refuse(409, `It is ${p.status}, not ${from}.`);
    console.log(`[crypto] payment ${id} ${to} by ${actor}${why ? ": " + why : ""}`);
    return { status: to };
  }
  if (action === "refunded") {
    // 1.99ts: a held payment the owner sent back from the receiving wallet, outside PATV - never credited; the donor is told
    const r = await runQuery("UPDATE crypto_payments SET status = 'refunded', decided_by = ?, note = ? WHERE id = ? AND status = 'held'", [actor, why, id]);
    if (!r.changes) throw refuse(409, `It is ${p.status}, not held.`);
    console.log(`[crypto] payment ${id} marked refunded off-site by ${actor}${why ? ": " + why : ""}`);
    if (p.user_id) await notify({ kind: "refunded", userId: p.user_id, p });
    return { status: "refunded" };
  }
  if (action === "reverify") {
    const r = await runQuery("UPDATE crypto_payments SET status = 'verifying', decided_by = ?, note = ? WHERE id = ? AND status = 'suspect'", [actor, why, id]);
    if (!r.changes) throw refuse(409, `It is ${p.status}, not suspect.`);
    return { status: await verifyAndSettle(id) };
  }
  if (action === "unignore") {
    const r = await runQuery("UPDATE crypto_payments SET status = 'unclaimed', decided_by = ? WHERE id = ? AND status = 'ignored'", [actor, id]);
    if (!r.changes) throw refuse(409, `It is ${p.status}, not ignored.`);
    return { status: await settle(id) };
  }
  throw refuse(400, "Unknown action.");
}

// ── linking ──
const NONCE_TTL = 10 * 60 * 1000;
const ALLOWED_HOSTS = /^(publicaccess\.tv|www\.publicaccess\.tv|staging\.publicaccess\.tv|localhost(:\d+)?|127\.0\.0\.1(:\d+)?)$/i;
function siteBase() {
  return process.env.PUBLIC_BASE_URL || process.env.SITE_URL || (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv");
}
/** The domain + URI a signed message names: the page's own host when it's one of ours, else the site's. */
function origin(host) {
  if (host && ALLOWED_HOSTS.test(String(host))) {
    const local = /^(localhost|127\.0\.0\.1)/i.test(host);
    return { domain: String(host).toLowerCase(), uri: (local ? "http://" : "https://") + String(host).toLowerCase() };
  }
  const u = new URL(siteBase());
  return { domain: u.host, uri: u.origin };
}
/** Step 1: a message for `user` to sign with `address`. -> {nonce, message, family, address} */
async function linkStart(user, family, address, host) {
  await init();
  if (!user || !user.userId) throw refuse(401, "Sign in first.");
  if (!enabled()) throw refuse(404, "Crypto donations aren't on.");
  if (family !== "evm" && family !== "sol") throw refuse(400, "Pick an Ethereum/Base or a Solana wallet.");
  const a = sig.norm(family, address);
  if (!a) throw refuse(400, "That wallet address isn't valid.");
  const other = await walletOwner(family, a);
  if (other && other !== user.userId) throw refuse(409, "That wallet is already linked to another PATV account.");
  if (other === user.userId) throw refuse(409, "That wallet is already linked to your account.");
  const n = (await getQuery("SELECT COUNT(*) AS n FROM crypto_wallets WHERE user_id = ?", [user.userId]))[0].n;
  if (n >= S.link_max_wallets) throw refuse(409, `You can link up to ${S.link_max_wallets} wallets.`);
  const now = clock();
  await runQuery("DELETE FROM crypto_link_nonces WHERE expires < ?", [now - 24 * 3600 * 1000]);
  const nonce = crypto.randomBytes(12).toString("hex");
  const o = origin(host);
  const message = family === "evm"
    ? sig.siweMessage({ domain: o.domain, uri: o.uri, address: a, nonce, issuedAt: now, expiresAt: now + NONCE_TTL, username: user.username })
    : sig.solMessage({ domain: o.domain, address: a, nonce, issuedAt: now, expiresAt: now + NONCE_TTL, username: user.username });
  await runQuery("INSERT INTO crypto_link_nonces (nonce, user_id, family, address, message, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)",
                 [nonce, user.userId, family, a, message, now, now + NONCE_TTL]);
  return { nonce, message, family, address: family === "evm" ? sig.toChecksum(a) : a };
}
/** Step 2: the signature over that message. Links the wallet, then credits anything it sent while unlinked. */
async function linkFinish(user, nonce, signature) {
  await init();
  if (!user || !user.userId) throw refuse(401, "Sign in first.");
  if (!enabled()) throw refuse(404, "Crypto donations aren't on.");
  const now = clock();
  const n = (await getQuery("SELECT * FROM crypto_link_nonces WHERE nonce = ?", [String(nonce || "").slice(0, 64)]))[0];
  if (!n || n.user_id !== user.userId) throw refuse(400, "That link request wasn't found - start again.");
  if (n.used) throw refuse(400, "That link request was already used - start again.");
  if (n.expires < now) throw refuse(400, "That link request expired - start again.");
  // single use, whatever the outcome
  const u = await runQuery("UPDATE crypto_link_nonces SET used = ? WHERE nonce = ? AND used IS NULL", [now, n.nonce]);
  if (!u.changes) throw refuse(400, "That link request was already used - start again.");
  let ok = false;
  if (n.family === "evm") {
    const f = sig.parseSiwe(n.message);
    ok = !!f && f.Nonce === n.nonce && sig.normEvm(f.address) === n.address && Date.parse(f["Expiration Time"]) >= now && sig.verifyEvm(n.message, signature, n.address);
  } else {
    ok = n.message.includes(`\nNonce: ${n.nonce}\n`) && n.message.includes(`\nWallet: ${n.address}\n`) && sig.verifySol(n.message, signature, n.address);
  }
  if (!ok) throw refuse(400, "The signature doesn't match that wallet. (Smart-contract wallets can't be linked - use a regular wallet.)");
  const linked = await tx(async () => {
    const other = await walletOwner(n.family, n.address);
    if (other && other !== user.userId) throw refuse(409, "That wallet is already linked to another PATV account.");
    if (other) return false;
    await runQuery(`INSERT INTO crypto_wallets (user_id, family, address, link_source, message, signature, created) VALUES (?, ?, ?, 'signature', ?, ?, ?)`,
                   [user.userId, n.family, n.address, n.message, String(signature).slice(0, 300), now]);
    await runQuery("INSERT INTO crypto_wallet_log (user_id, family, address, action, actor, at) VALUES (?, ?, ?, 'link', ?, ?)", [user.userId, n.family, n.address, user.username || null, now]);
    return true;
  });
  if (linked) console.log(`[crypto] ${user.username || user.userId} linked ${n.family} wallet ${n.address} (signature)`);
  if (linked) { try { require("./achievements").poke(user.userId); } catch (e) { /* achievements never block */ } }   // 1.99mt: 👛 Wallet Frog
  const claimed = await claimUnclaimed(n.family, n.address);
  return { linked: true, family: n.family, address: n.family === "evm" ? sig.toChecksum(n.address) : n.address, claimed };
}
async function unlink(user, id, actor) {
  await init();
  if (!user || !user.userId) throw refuse(401, "Sign in first.");
  const w = (await getQuery("SELECT * FROM crypto_wallets WHERE id = ?", [Number(id) || 0]))[0];
  if (!w || (w.user_id !== user.userId && !actor)) throw refuse(404, "No such wallet on your account.");
  await runQuery("DELETE FROM crypto_wallets WHERE id = ?", [w.id]);
  await runQuery("INSERT INTO crypto_wallet_log (user_id, family, address, action, actor, at) VALUES (?, ?, ?, 'unlink', ?, ?)", [w.user_id, w.family, w.address, actor || user.username || null, clock()]);
  console.log(`[crypto] ${w.family} wallet ${w.address} unlinked from ${w.user_id}${actor ? " by " + actor : ""}`);
  return { unlinked: true };
}

// ── the watcher ──
async function cursor(chain) { return (await getQuery("SELECT * FROM crypto_cursors WHERE chain = ?", [chain]))[0] || null; }
async function saveCursor(chain, patch) {
  const cur = await cursor(chain);
  if (!cur) await runQuery("INSERT OR IGNORE INTO crypto_cursors (chain) VALUES (?)", [chain]);
  const keys = Object.keys(patch);
  if (keys.length) await runQuery(`UPDATE crypto_cursors SET ${keys.map((k) => k + " = ?").join(", ")} WHERE chain = ?`, [...keys.map((k) => patch[k]), chain]);
}
async function pollEvm(chain) {
  const C = CHAINS[chain];
  const recv = receiver(chain);
  const { head, final } = await evmHeads(chain);
  let cur = await cursor(chain);
  if (!cur || cur.last_block == null || cur.recv !== recv) {
    // first scan of this address (or a new receiving address): start at the finalized head minus the configured lookback
    await saveCursor(chain, { last_block: Math.max(0, final - Number(S.start_lookback_blocks || 0)), recv });
    cur = await cursor(chain);
  }
  let last = Number(cur.last_block);
  let seen = 0;
  for (let i = 0; i < C.maxChunks && last < final; i++) {
    const from = last + 1, to = Math.min(final, last + C.chunk);
    for (const t of await evmLogs(chain, from, to, recv)) { await record(t, true); seen++; }
    last = to;
    await saveCursor(chain, { last_block: last });
  }
  // a transfer seen as pending that the finalized chain doesn't have (a reorg) - dropped, never credited
  await runQuery("UPDATE crypto_payments SET status = 'dropped' WHERE chain = ? AND status = 'pending' AND block <= ?", [chain, last]);
  if (last >= final && head > final) {
    const from = Math.max(final + 1, head - C.chunk + 1);
    for (const t of await evmLogs(chain, from, head, recv)) await record(t, false);
  }
  await saveCursor(chain, { head, final_head: final, last_ok: clock(), errors: 0, next_try: 0 });
  return { chain, head, final, last, seen };
}
async function pollSol() {
  const owner = receiver("sol");
  let cur = await cursor("sol");
  const baseline = !cur || cur.recv !== owner;      // first look at this wallet: its token accounts' history is skipped
  const slot = await rpc("sol", "getSlot", [{ commitment: "finalized" }]);
  let seen = 0;
  for (const { account, mint } of await solAccounts(owner)) {
    const c = (await getQuery("SELECT * FROM crypto_sol_cursors WHERE account = ?", [account]))[0];
    if (!c) {
      let last = null;
      if (baseline && Number(S.start_lookback_blocks || 0) === 0) {
        const top = (await rpc("sol", "getSignaturesForAddress", [account, { limit: 1, commitment: "finalized" }])) || [];
        last = top.length ? top[0].signature : null;
      }
      await runQuery("INSERT INTO crypto_sol_cursors (account, mint, recv, last_sig, updated) VALUES (?, ?, ?, ?, ?)", [account, mint, owner, last, clock()]);
      if (last) continue;
    }
    const since = c ? c.last_sig : (await getQuery("SELECT last_sig FROM crypto_sol_cursors WHERE account = ?", [account]))[0].last_sig;
    for (const s of await solSignatures(account, since)) {
      if (!s.err) {
        const txr = await solTx(s.signature);
        if (!txr) throw new Error("Solana: a finalized transaction wasn't returned yet - retried");
        for (const t of parseSolTx(s.signature, txr, account, mint, owner)) { await record(t, true); seen++; }
      }
      await runQuery("UPDATE crypto_sol_cursors SET last_sig = ?, last_slot = ?, updated = ? WHERE account = ?", [s.signature, s.slot || null, clock(), account]);
    }
  }
  await saveCursor("sol", { recv: owner, head: slot, final_head: slot, last_block: slot, last_ok: clock(), errors: 0, next_try: 0 });
  return { chain: "sol", slot, seen };
}
let timer = null, running = false, stopped = true;
const watching = () => enabled() || !!S.watch_when_off;
/** One pass over every chain that's due (each has its own backoff). */
async function pollOnce({ force = false } = {}) {
  await init();
  const out = {};
  for (const chain of CHAIN_IDS) {
    if (!chainOn(chain)) continue;
    const cur = await cursor(chain);
    if (!force && cur && cur.next_try && cur.next_try > clock()) { out[chain] = { skipped: "backoff" }; continue; }
    try { out[chain] = CHAINS[chain].family === "evm" ? await pollEvm(chain) : await pollSol(); } catch (e) {
      const errors = ((cur && cur.errors) || 0) + 1;
      const wait = Math.min(15 * 60 * 1000, S.poll_sec * 1000 * 2 ** Math.min(errors, 6));
      const msg = String(e && e.message || e).replace(/https?:\/\/\S+/g, "<url>").replace(/[A-Za-z0-9]{32,}/g, "…").slice(0, 200);
      await saveCursor(chain, { last_error: msg, last_error_at: clock(), errors, next_try: clock() + wait }).catch(() => {});
      if (errors <= 3 || errors % 10 === 0) console.error(`[crypto] ${chain} watcher: ${msg} (retry in ${Math.round(wait / 1000)} s)`);
      out[chain] = { error: msg };
    }
  }
  // a final payment the verifier couldn't confirm yet, or whose settlement failed half-way (rolled back), is retried here
  for (const r of await getQuery("SELECT id FROM crypto_payments WHERE status IN ('verifying', 'final') ORDER BY seen LIMIT 50")) {
    try { await verifyAndSettle(r.id); } catch (e) { console.error(`[crypto] settle ${r.id}: ${e.message}`); }
  }
  return out;
}
function schedule(ms) {
  if (stopped) return;
  clearTimeout(timer);
  timer = setTimeout(tick, ms);
  if (timer.unref) timer.unref();
}
async function tick() {
  if (running) return schedule(5000);
  running = true;
  try { await loadSettings(); if (watching()) await pollOnce(); } catch (e) { console.error("[crypto] watcher:", e.message); } finally { running = false; }
  schedule(Math.max(20, Number(S.poll_sec) || 60) * 1000);
}
function start() { stopped = false; init().then(() => schedule(15000)).catch((e) => console.error("[crypto] setup:", e.message)); }
function stop() { stopped = true; clearTimeout(timer); }
function kick() { if (!stopped) schedule(1000); }

// ── views ──
async function health() {
  await init();
  const rows = await getQuery("SELECT * FROM crypto_cursors");
  return CHAIN_IDS.map((c) => {
    const r = rows.find((x) => x.chain === c) || {};
    return { chain: c, name: CHAINS[c].name, on: chainOn(c), rpc: rpcInfo(c), verify: S.verify_payments ? rpcInfo(c, "verify") : null, last_block: r.last_block, head: r.head, final_head: r.final_head,
             last_ok: r.last_ok, last_error: r.last_error, last_error_at: r.last_error_at, errors: r.errors || 0, next_try: r.next_try || 0 };
  });
}
const explorer = (p) => CHAINS[p.chain] ? CHAINS[p.chain].explorer + p.tx : null;
/** The viewer's payments: credited / held to them, plus anything (pending, unclaimed...) from a wallet they've linked. */
async function mine(userId, limit = 50) {
  await init();
  const rows = await getQuery(`SELECT p.* FROM crypto_payments p WHERE p.user_id = ? OR EXISTS (SELECT 1 FROM crypto_wallets w
      WHERE w.user_id = ? AND w.address = p.src_addr) ORDER BY p.seen DESC LIMIT ?`, [userId, userId, limit]);
  return rows.map((p) => ({ ...p, explorer: explorer(p), chain_name: CHAINS[p.chain] ? CHAINS[p.chain].name : p.chain }));
}
async function adminList({ status, limit = 200 } = {}) {
  await init();
  const where = status ? "WHERE p.status = ?" : "";
  const rows = await getQuery(`SELECT p.*, u.username FROM crypto_payments p LEFT JOIN users u ON u.userId = p.user_id ${where}
                               ORDER BY p.seen DESC LIMIT ?`, status ? [status, limit] : [limit]);
  return rows.map((p) => ({ ...p, explorer: explorer(p), chain_name: CHAINS[p.chain] ? CHAINS[p.chain].name : p.chain }));
}
async function totals() {
  await init();
  return getQuery("SELECT status, COUNT(*) AS n, COALESCE(SUM(usd_cents), 0) AS cents, COALESCE(SUM(pat), 0) AS pat FROM crypto_payments GROUP BY status");
}

/**
 * READ-ONLY scan for the admin / the dry-run tool: what the watcher WOULD do with each final incoming transfer in the
 * last `blocks` EVM blocks / `sigs` Solana signatures per token account. Writes nothing, mints nothing.
 * opts.receiver: {eth, base, sol} overrides (to exercise the parser on a busy address).
 */
async function dryRun({ chains = CHAIN_IDS, blocks = 5000, sigs = 50, receivers = {} } = {}) {
  await init();
  const out = {};
  for (const chain of chains) {
    const recv = receivers[chain] || receiver(chain);
    if (!recv) { out[chain] = { error: "no receiving address" }; continue; }
    try {
      let transfers = [];
      let range = null;
      if (CHAINS[chain].family === "evm") {
        const h = await evmHeads(chain);
        const lo = Math.max(0, h.final - blocks + 1);
        for (let from = lo; from <= h.final; from += CHAINS[chain].chunk) {
          transfers.push(...(await evmLogs(chain, from, Math.min(h.final, from + CHAINS[chain].chunk - 1), recv)));
        }
        range = { from: lo, to: h.final, head: h.head, finality: h.how };
      } else {
        const accts = await solAccounts(recv);
        range = { accounts: accts.length };
        for (const { account, mint } of accts) {
          const list = ((await rpc("sol", "getSignaturesForAddress", [account, { limit: sigs, commitment: "finalized" }])) || []).reverse();
          for (const s of list) if (!s.err) transfers.push(...parseSolTx(s.signature, await solTx(s.signature), account, mint, recv));
        }
      }
      const rows = [];
      for (const t of transfers) {
        const ex = (await getQuery("SELECT status FROM crypto_payments WHERE id = ?", [t.id]))[0];
        const owner = await walletOwner(familyOf(chain), t.src_addr);
        const c = classify(t.usd_cents, owner);
        rows.push({ id: t.id, token: t.token, from: t.src_addr, usd: usd(t.usd_cents), already: ex ? ex.status : null,
                    would: c === "credit" ? `credit ${patFor(t.usd_cents).pat} PAT to ${owner}` : c, transfer: t });
      }
      out[chain] = { receiver: recv, range, transfers: rows };
    } catch (e) { out[chain] = { error: String(e.message || e).replace(/https?:\/\/\S+/g, "<url>").slice(0, 200) }; }
  }
  return out;
}

module.exports = {
  init, get, set, enabled, accepted, rpcInfo, receiver, chainOn, TOKENS, CHAINS, DEFAULTS, TRANSFER_TOPIC,
  centsOf, classify, patFor, parseEvmLogs, parseSolTx, evmHeads, record, settle, decide, confirm, verifyAndSettle, claimUnclaimed, claimIdOf,
  linkStart, linkFinish, unlink, wallets, walletOwner, origin,
  pollOnce, pollEvm, pollSol, start, stop, kick, health, mine, adminList, totals, dryRun, usd,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _setFetch: (fn) => { fetchImpl = fn || ((...a) => fetch(...a)); },
  _S: S,
};
