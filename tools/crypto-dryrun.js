#!/usr/bin/env node
// tools/crypto-dryrun.js — 1.99ks: a READ-ONLY mainnet check of the crypto donation watcher (cryptopay.js).
//   1. confirms every reviewed token on-chain: EVM decimals() + symbol(), Solana mint decimals (getTokenSupply);
//   2. reads the receiving addresses' recent FINALIZED incoming USDC/USDT transfers and prints what the watcher WOULD
//      credit (cryptopay.dryRun) - it writes nothing and mints nothing.
// Runs against a scratch database in a temp directory (never the site's myapp.db). Public RPCs by default; env
// CRYPTO_RPC_ETH / _BASE / _SOL override (never printed).
//   node tools/crypto-dryrun.js [--blocks=5000] [--sigs=50] [--eth=0x..] [--base=0x..] [--sol=...] [--verify=3]
// --verify=N re-checks the first N transfers per chain on the independent verifier RPC (cryptopay.confirm), read-only.
// The --eth/--base/--sol overrides scan someone else's (busy) address to exercise the parser on real traffic.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const repo = path.resolve(__dirname, "..");
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "crypto-dryrun-")));
const { runQuery } = require(path.join(repo, "dbUtils"));
const CP = require(path.join(repo, "cryptopay"));

async function call(chain, method, params) {
  const url = { eth: process.env.CRYPTO_RPC_ETH || CP.CHAINS.eth.rpc, base: process.env.CRYPTO_RPC_BASE || CP.CHAINS.base.rpc, sol: process.env.CRYPTO_RPC_SOL || CP.CHAINS.sol.rpc }[chain];
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${chain} ${method}: ${j.error.message}`);
  return j.result;
}
function abiString(hex) {
  const b = Buffer.from(String(hex).slice(2), "hex");
  if (b.length >= 96) { const len = Number(BigInt("0x" + b.subarray(32, 64).toString("hex"))); return b.subarray(64, 64 + len).toString("utf8"); }
  return b.toString("utf8").replace(/\0+$/, "");
}

(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT, points_balance INTEGER DEFAULT 0)`);
  await CP.init();
  console.log("== reviewed tokens, checked on-chain");
  let bad = 0;
  for (const chain of ["eth", "base"]) {
    for (const [addr, t] of Object.entries(CP.TOKENS[chain])) {
      const dec = parseInt(await call(chain, "eth_call", [{ to: addr, data: "0x313ce567" }, "latest"]), 16);
      const sym = abiString(await call(chain, "eth_call", [{ to: addr, data: "0x95d89b41" }, "latest"]));
      const ok = dec === t.decimals && sym === t.symbol;
      if (!ok) bad++;
      console.log(`${ok ? "ok " : "BAD"} ${chain} ${t.symbol} ${addr}: decimals ${dec}, symbol ${JSON.stringify(sym)}`);
    }
  }
  for (const [mint, t] of Object.entries(CP.TOKENS.sol)) {
    const s = await call("sol", "getTokenSupply", [mint, { commitment: "finalized" }]);
    const ok = s && s.value && s.value.decimals === t.decimals;
    if (!ok) bad++;
    console.log(`${ok ? "ok " : "BAD"} sol ${t.symbol} ${mint}: decimals ${s && s.value && s.value.decimals}, supply ${s && s.value && s.value.uiAmountString}`);
  }
  const receivers = {};
  for (const c of ["eth", "base", "sol"]) if (arg(c)) receivers[c] = arg(c);
  console.log(`\n== dry run (read-only${Object.keys(receivers).length ? ", receiver overrides: " + Object.keys(receivers).join(", ") : ""})`);
  const r = await CP.dryRun({ blocks: Number(arg("blocks", 5000)), sigs: Number(arg("sigs", 50)), receivers });
  for (const [chain, x] of Object.entries(r)) {
    if (x.error) { console.log(`${chain}: ERROR ${x.error}`); bad++; continue; }
    console.log(`${chain}: receiver ${x.receiver} ${JSON.stringify(x.range)} -> ${x.transfers.length} incoming transfer(s)`);
    const byWould = {};
    for (const t of x.transfers) byWould[t.would.split(" ")[0]] = (byWould[t.would.split(" ")[0]] || 0) + 1;
    if (x.transfers.length) console.log("   outcomes:", JSON.stringify(byWould));
    for (const t of x.transfers.slice(0, 8)) console.log(`   ${t.id.slice(0, 40)}… ${t.usd} ${t.token} from ${t.from.slice(0, 10)}… -> ${t.would}`);
    for (const t of x.transfers.slice(0, Number(arg("verify", 0)))) {
      let v;
      try { v = (await CP.confirm(t.transfer)) ? "verifier AGREES" : "verifier DISAGREES"; } catch (e) { v = "verifier can't tell yet: " + e.message; }
      if (v === "verifier DISAGREES") bad++;
      console.log(`   verify ${t.id.slice(0, 40)}… -> ${v}`);
    }
  }
  console.log(bad ? `\n${bad} problem(s)` : "\nclean");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
