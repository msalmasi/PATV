// opsalerts.js — 1.99aai: ops alerts from the VPS's own watchdogs (first user: deploy/webrtc/pepe-relay-watchdog.sh, which
// restarts Pepe's main-stream HLS relay when nginx-rtmp's HLS of it goes bad - the 2026-10-14 8-hour A/V drift outage).
//
// POST /api/ops/alert  {password: <bot token>, source, ref, title, body}
//   * loopback only, and never through the web proxy (nginx sets X-Forwarded-For / X-Real-IP; a request carrying either
//     is refused), plus the bot token (TWITCH_BOT_TOKEN, the same one Pepe uses) - so only a process ON the VPS that can
//     read the site's .env can file one;
//   * every site admin (users.class 'Admin', not archived) gets a 🛠️ Admin notice in the website inbox, and a Telegram
//     alert through the existing alerts outbox (telegram_outbox, which Pepe's bot drains) under the kind "ops" - on by
//     default (telegram.DEFAULT_ON), only ever queued for admins;
//   * idempotent per ref (inbox ref + outbox ref "ops:<source>:<ref>"), at most RATE_MAX alerts per source an hour
//     (the watchdog has its own backoff; this is the backstop).
// -> {ok, admins, inbox, telegram} | {ok:false, error}
"use strict";
const { getQuery } = require("./dbUtils");

const RATE_MAX = 12;
const HOUR = 3600e3;
let clock = () => Date.now();
const recent = new Map();             // source -> [timestamps]

const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, n);
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function direct(req) {
  const ip = req.socket && req.socket.remoteAddress;
  if (!LOOPBACK.has(String(ip || ""))) return false;
  if (req.get("x-forwarded-for") || req.get("x-real-ip") || req.get("forwarded")) return false;   // came through nginx
  return true;
}

async function admins() {
  const cols = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  const arch = cols.has("archived_at") ? " AND archived_at IS NULL" : "";
  return getQuery(`SELECT userId, username FROM users WHERE class = 'Admin'${arch}`);
}

/** File one ops alert for every site admin. a = {source, ref, title, body} -> {admins, inbox, telegram} | {limited:true} */
async function alert(a = {}) {
  const source = clean(a.source, 40).replace(/[^\w.-]/g, "") || "ops";
  const ref = clean(a.ref, 80) || String(clock());
  const title = clean(a.title, 150);
  const body = clean(a.body, 1500);
  if (!title) throw Object.assign(new Error("title required"), { status: 400 });
  const t = clock();
  const list = (recent.get(source) || []).filter((x) => t - x < HOUR);
  if (list.length >= RATE_MAX) { recent.set(source, list); return { limited: true }; }
  list.push(t);
  recent.set(source, list);
  const inbox = require("./inbox");
  const tg = require("./telegram");
  const key = `ops:${source}:${ref}`;
  let nIn = 0, nTg = 0;
  const who = await admins();
  for (const u of who) {
    if (await inbox.addSafe(u.userId, { kind: "admin", title: `🚨 ${title}`, body, ref: key, telegram: false })) nIn++;
    if (await tg.queue(u.userId, { kind: "ops", text: `🚨 ${title}${body ? "\n" + body : ""}`, ref: key })) nTg++;
  }
  console.log(`[ops] alert ${key}: ${title} -> ${who.length} admin(s), inbox ${nIn}, telegram ${nTg}`);
  return { admins: who.length, inbox: nIn, telegram: nTg };
}

function register(app, { isBotToken }) {
  app.post("/api/ops/alert", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!direct(req)) return res.status(403).json({ ok: false, error: "loopback only" });
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      const r = await alert(b);
      res.json({ ok: true, ...r });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ ok: false, error: e.message });
      console.error("[ops] alert:", e.message);
      res.status(500).json({ ok: false, error: "failed" });
    }
  });
}

module.exports = { register, alert, direct, RATE_MAX, _setClock: (fn) => { clock = fn || (() => Date.now()); }, _reset: () => recent.clear() };
