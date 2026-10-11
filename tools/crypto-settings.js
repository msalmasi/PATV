#!/usr/bin/env node
// tools/crypto-settings.js — 1.99ks: read / change the crypto donation settings (cryptopay.js) from the server's shell,
// the same validation as /admin/crypto. Run in the site directory (it opens ./myapp.db). The running site picks a change
// up on its watcher's next tick (poll_sec), no restart. Every change is logged with the actor.
//   node tools/crypto-settings.js                                   # print the settings + watcher health
//   node tools/crypto-settings.js --actor=<who> key=value [...]      # e.g. crypto_donations_enabled=true
"use strict";
const path = require("path");
const CP = require(path.join(__dirname, "..", "cryptopay"));
(async () => {
  await CP.init();
  const actor = (process.argv.find((a) => a.startsWith("--actor=")) || "").slice(8);
  const pairs = process.argv.slice(2).filter((a) => !a.startsWith("--") && a.includes("="));
  if (pairs.length) {
    if (!actor) throw new Error("say who is changing it: --actor=<name>");
    const patch = {};
    for (const p of pairs) { const i = p.indexOf("="); patch[p.slice(0, i)] = p.slice(i + 1); }
    const r = await CP.set(patch, actor + " (cli)");
    console.log("changed:", r.changed.join(", ") || "nothing");
  }
  const S = CP.get();
  for (const k of Object.keys(S)) if (!/^rpc_|^verify_rpc_/.test(k)) console.log(`${k} = ${JSON.stringify(S[k])}`);
  for (const h of await CP.health()) console.log(`${h.chain}: on=${h.on} rpc=${h.rpc.host}${h.rpc.from_env ? "(env)" : ""} verify=${h.verify ? h.verify.host : "off"} scanned=${h.last_block} final=${h.final_head} errors=${h.errors}${h.last_error ? " last_error=" + h.last_error : ""}`);
  console.log("totals:", JSON.stringify(await CP.totals()));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
