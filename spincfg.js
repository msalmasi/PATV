// spincfg.js — 1.99yz: how Pepe tells the room about a CHAT wheel spin (!spin in Camfrog; camfrog-bot frida-bot handle_spin).
//
// The user (2026-10-14): "Make chat spins private by default (acknowledge and send the result over /msg), only announce it in
// the room when there's a jackpot." One knob:
//
//   chat_private   true (default): Pepe answers a !spin with a short line in the room ("spinning - result by /msg") and
//                  sends the result as a private message; ONLY a jackpot (the wheel's jackpot slice + its roll, result.jackpot)
//                  is still shouted in the room. false: the old behaviour (every result in the room).
//
// Pepe reads it from the chat spin's own answer (POST /api/g/wheel/chatspin -> {spinId, chat_private}), so a change applies
// to the next !spin. Website spins (/wheel, the OBS wheel page) are not touched.
//
//   GET  /api/admin/spin-cfg   (admins)                       -> {ok, cfg, defaults}
//   POST /api/admin/spin-cfg   (admins, same-site fetch JSON)  {chat_private} -> {ok, cfg}   (admin_audit "spin-cfg")
// The card is /admin/games#chatspin (views/partials/admin-spincfg.ejs) - never on a public page.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const DEFAULTS = Object.freeze({ chat_private: true });

let ready = null;
function init() {
  if (!ready) ready = runQuery("CREATE TABLE IF NOT EXISTS spin_cfg (key TEXT PRIMARY KEY, value TEXT)").catch((e) => { ready = null; throw e; });
  return ready;
}

function clean(c) {
  const out = { ...DEFAULTS };
  if (c && typeof c.chat_private === "boolean") out.chat_private = c.chat_private;
  return out;
}

let cache = null, cacheAt = 0;
async function get() {
  if (cache && Date.now() - cacheAt < 15000) return cache;
  await init();
  const row = (await getQuery("SELECT value FROM spin_cfg WHERE key = 'cfg'"))[0];
  let raw = null;
  try { raw = row ? JSON.parse(row.value) : null; } catch (e) { raw = null; }
  cache = clean(raw);
  cacheAt = Date.now();
  return cache;
}
/** For the chat spin's answer: never throws (the default when the table can't be read). */
async function chatPrivate() {
  try { return (await get()).chat_private; } catch (e) { return DEFAULTS.chat_private; }
}

async function set(patch) {
  await init();
  const next = clean({ ...(await get()), ...(patch || {}) });
  await runQuery("INSERT INTO spin_cfg (key, value) VALUES ('cfg', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
  cache = next;
  cacheAt = Date.now();
  return next;
}

function register(app, { addUser }) {
  const admin = async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false }); return false; }
    const row = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!SP.can(row, "games.config")) { res.status(403).json({ ok: false, error: "Admins only." }); return false; }
    return true;
  };
  app.get("/api/admin/spin-cfg", addUser, async (req, res) => {
    if (!(await admin(req, res))) return;
    res.json({ ok: true, cfg: await get(), defaults: DEFAULTS });
  });
  app.post("/api/admin/spin-cfg", addUser, async (req, res) => {
    if (!(await admin(req, res))) return;
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    const b = req.body || {};
    if (typeof b.chat_private !== "boolean") return res.status(400).json({ ok: false, error: "chat_private must be true or false" });
    const cfg = await set({ chat_private: b.chat_private });
    console.log(`[spincfg] ${req.user.username || req.user.userId}: chat spins ${cfg.chat_private ? "private" : "public"}`);
    await require("./adminaudit").record(req.user, "spin-cfg", null, cfg).catch((e) => console.warn(`[spincfg] audit: ${e.message}`));
    res.json({ ok: true, cfg });
  });
}

module.exports = { register, get, set, clean, chatPrivate, DEFAULTS, _reset: () => { cache = null; } };
