#!/usr/bin/env node
// tools/relay-latency.js - 1.99ye: measure the web -> Camfrog chat relay end to end on STAGING (the bot-token test routes
// in bridge.js only exist when STAGING is set). Run on the VPS from the staging checkout, so the bot token never leaves it:
//
//   cd /home/PATV-staging && node tools/relay-latency.js --slug <pad slug> --login <linked camfrog login> [--n 12] [--gap 4]
//        [--burst 5] [--page lp|poll] [--base http://127.0.0.1:3100]
//
// For each line: POST /api/bridge/test/say (as the account linked to --login), while a "page" watches the pad the way a
// browser does - `lp` = the long-poll (/live?wait=1), `poll` = every 1.5 s (the old page). Reported per line:
//   sent = until the page shows "✓ sent" (Pepe's ack), echo = until the room's own line is on the page;
// and from the site's own timings (bridge-relay.latency): claim (Pepe took the job), ack, echo (ms after the site took it),
// pepe-wait / pepe-send (Pepe's clock: his say lane, his send queue up to the packet going out).
// --burst N then sends N lines back to back (the queue + Pepe's pacing).
"use strict";
require("dotenv").config();

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? a.concat([[x.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]]) : a), []));
const BASE = String(args.base || "http://127.0.0.1:3100").replace(/\/+$/, "");
const SLUG = String(args.slug || "");
const LOGIN = String(args.login || "");
const N = Math.max(1, parseInt(args.n, 10) || 12);
const GAP = Math.max(0.5, Number(args.gap) || 4) * 1000;
const BURST = Math.max(0, parseInt(args.burst, 10) || 0);
const PAGE = args.page === "poll" ? "poll" : "lp";
const TOKEN = process.env.TWITCH_BOT_TOKEN;
if (!SLUG || !LOGIN || !TOKEN) { console.error("usage: --slug <pad> --login <camfrog login>  (and TWITCH_BOT_TOKEN in .env)"); process.exit(2); }

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: TOKEN }, body)) });
  return { status: r.status, d: await r.json().catch(() => null) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] : null; };
const stat = (xs) => ({ n: xs.filter(Number.isFinite).length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: pct(xs, 1) });

// the "page": watches mine + feed like a browser would
const watch = { cursor: 0, ver: null, mver: null, stop: false, seen: new Map() };   // cid -> {sentAt, echoAt, failAt, why}
async function page() {
  const first = await post("/api/bridge/test/live", { slug: SLUG, login: LOGIN, after: 0 });
  if (first.status !== 200) throw new Error("live: HTTP " + first.status);
  watch.cursor = first.d.cursor; watch.ver = first.d.ver; watch.mver = first.d.mver;
  while (!watch.stop) {
    const t = Date.now();
    const r = await post("/api/bridge/test/live", PAGE === "lp"
      ? { slug: SLUG, login: LOGIN, after: watch.cursor, wait: 1, v: watch.ver, mv: watch.mver }
      : { slug: SLUG, login: LOGIN, after: watch.cursor });
    const now = Date.now();
    if (r.status === 200 && r.d) {
      watch.cursor = Math.max(watch.cursor, r.d.cursor || 0); watch.ver = r.d.ver; watch.mver = r.d.mver;
      for (const j of r.d.mine || []) {
        if (j.kind !== "say" || !j.cid) continue;
        const s = watch.seen.get(j.cid) || {};
        if (j.state === "done" && j.ok && !s.sentAt) s.sentAt = now;
        if (j.c && j.c <= watch.cursor && !s.echoAt) { s.echoAt = now; if (!s.sentAt) s.sentAt = now; }
        if (j.state === "done" && !j.ok && !s.failAt) { s.failAt = now; s.why = (j.code || "") + " " + (j.msg || ""); }
        watch.seen.set(j.cid, s);
      }
    } else await sleep(1000);
    if (PAGE === "poll") await sleep(Math.max(0, 1500 - (Date.now() - t)));
  }
}

async function sendLine(i, tag) {
  const cid = "cLAT" + Date.now().toString(36) + i;
  const t0 = Date.now();
  const r = await post("/api/bridge/test/say", { slug: SLUG, login: LOGIN, text: `[latency ${tag} ${i}/${N}] ${new Date().toISOString().slice(11, 23)}`, cid });
  if (r.status !== 200 || !r.d || !r.d.ok) return { i, cid, t0, err: (r.d && (r.d.code || r.d.error)) || "HTTP " + r.status };
  return { i, cid, t0, id: r.d.id };
}
async function settle(lines, ms = 35000) {
  const until = Date.now() + ms;
  while (Date.now() < until && lines.some((l) => !l.err && !(watch.seen.get(l.cid) || {}).echoAt && !(watch.seen.get(l.cid) || {}).failAt)) await sleep(100);
}

(async () => {
  const pg = page().catch((e) => { console.error("page:", e.message); process.exit(1); });
  await sleep(500);
  console.log(`relay latency: pad=${SLUG} page=${PAGE} n=${N} gap=${GAP / 1000}s burst=${BURST}`);
  const lines = [];
  for (let i = 1; i <= N; i++) {
    lines.push(await sendLine(i, "single"));
    await settle(lines.slice(-1), 35000);
    await sleep(GAP);
  }
  const burst = [];
  for (let i = 1; i <= BURST; i++) burst.push(await sendLine(i, "burst"));
  if (burst.length) await settle(burst, 45000);
  watch.stop = true;
  const lat = (await post("/api/bridge/test/latency", {})).d || {};
  const byId = new Map();
  for (const l of [...lines, ...burst]) if (l.id) byId.set(l.id, l);
  const report = (ls, name) => {
    const sent = [], echo = [], fails = [];
    for (const l of ls) {
      const s = watch.seen.get(l.cid) || {};
      if (l.err) { fails.push(l.err); continue; }
      if (s.failAt) { fails.push(s.why); continue; }
      sent.push(s.sentAt ? s.sentAt - l.t0 : NaN);
      echo.push(s.echoAt ? s.echoAt - l.t0 : NaN);
    }
    console.log(`${name}: page shows ✓ sent ${JSON.stringify(stat(sent))} | room line on the page ${JSON.stringify(stat(echo))}` + (fails.length ? ` | failed ${fails.length}: ${[...new Set(fails)].join("; ")}` : ""));
    return { sent, echo };
  };
  report(lines, "single");
  if (burst.length) {
    const b = report(burst, "burst ");
    console.log(`burst: last line's room line on the page after ${b.echo[b.echo.length - 1]} ms`);
  }
  // the site's own per-hop timings for these lines (ms after the site took the line)
  const samples = (lat.samples || []).filter((s) => [...byId.values()].some((l) => Math.abs(l.t0 - s.at) < 3000));
  const col = (k, f = (s) => s[k]) => stat(samples.map(f).map((x) => (x == null ? NaN : x)));
  console.log("site hops:", JSON.stringify({ claim: col("claim"), ack: col("ack"), echo: col("echo"),
    pepe_wait: col("w", (s) => (s.pepe ? s.pepe.wait : null)), pepe_send: col("s", (s) => (s.pepe ? s.pepe.send : null)),
    via: [...new Set(samples.map((s) => s.via))] }));
  await Promise.race([pg, sleep(PAGE === "lp" ? 21000 : 1600)]);
  process.exit(0);
})();
