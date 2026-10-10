// stickers.js — 🧸 chat sticker packs, a cosmetic sold for PAT (1.99iw). Catalog: stickers.json; art:
// public/stickers/<pack>/<sticker>.svg (tools/gen-stickers.py).
//
// OWNERSHIP: a pack belongs to an ACCOUNT, for good (user_sticker_packs, one row per account + pack). Ways in:
//   * buy it with PAT (the price is the pack's own, else the premium_config sticker_price setting, 250,000);
//   * someone GIFTS it (buys it for you - you get an inbox notice);
//   * a 🎟️ Season Pass holder claims it free from the monthly allowance (premium_config sp_sticker_packs per UTC
//     calendar month, default 1).
//   It shows in the /cosmetics inventory ("Sticker packs") and on /premium.
// MONEY: the PAT route is the "stickers" row of premium.js's routing table (default 100% Fort Knox); one SQLite
// transaction: debit (ledger.post, transaction id from the ref) + claim + the pack row; the client's ref makes a
// double click charge once.
//
// USING THEM: a sticker is the token [sticker:<pack>/<sticker>] in the text. It works in direct messages
// (messages.js) and posts / comments (feedweb.js / feedstore.js). The SENDER must own the pack - validate()
// refuses the send otherwise; rendering (inline()) turns known tokens in already-escaped HTML into <img>s and
// leaves anything else as the plain text. The composers get a picker (public/js/stickers.js, any button with
// data-sticker-picker="<textarea selector>").
// NATIVE PATV CHAT (later): use the same hook - module.exports.chat = {validate, inline, TOKEN_RE}: validate the
// sender's line before broadcasting it, run inline() on the escaped line when rendering.
//
// Routes: GET /api/stickers (catalog + mine + allowance), POST /api/stickers/buy {pack, ref, to?, allowance?}
"use strict";
const fs = require("fs");
const path = require("path");
const { runQuery, getQuery } = require("./dbUtils");

const ID_RE = /^[a-z0-9]{1,32}$/;
const REF_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TOKEN_RE = /\[sticker:([a-z0-9]{1,32})\/([a-z0-9]{1,32})\]/g;
const MAX_PER_TEXT = 12;
let clock = () => Date.now();
const now = () => clock();
const fmt = (n) => Number(n).toLocaleString("en-US");

function loadCatalog(file = path.join(__dirname, "stickers.json")) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error("[stickers] catalog:", e.message); }
  const packs = [];
  for (const p of raw.packs || []) {
    if (!p || !ID_RE.test(String(p.id))) { console.error("[stickers] bad pack id", p && p.id); continue; }
    const stickers = [];
    for (const s of p.stickers || []) {
      if (!s || !ID_RE.test(String(s.id))) continue;
      if (!fs.existsSync(path.join(__dirname, "public", "stickers", p.id, s.id + ".svg"))) { console.error(`[stickers] ${p.id}/${s.id}: no art`); continue; }
      stickers.push(Object.freeze({ id: s.id, name: String(s.name || s.id).slice(0, 40), url: `/public/stickers/${p.id}/${s.id}.svg` }));
    }
    if (!stickers.length) continue;
    packs.push(Object.freeze({ id: p.id, name: String(p.name || p.id).slice(0, 40), emoji: String(p.emoji || "🧸").slice(0, 8),
      desc: String(p.desc || "").slice(0, 200), price: Number(p.price) > 0 ? Math.floor(Number(p.price)) : null, retired: !!p.retired,
      stickers: Object.freeze(stickers), byId: Object.freeze(Object.fromEntries(stickers.map((s) => [s.id, s]))) }));
  }
  return { packs, byId: Object.fromEntries(packs.map((p) => [p.id, p])) };
}
let CAT = loadCatalog();
const P = () => require("./premium");
const priceOf = (pack) => pack.price || P().config().sticker_price;

class Refuse extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.refuse = true; this.code = code || { 400: "E_BAD_ARGS", 401: "E_NO_PERMISSION", 402: "E_INSUFFICIENT_PAT", 403: "E_NO_PERMISSION", 404: "E_TARGET_NOT_FOUND", 409: "E_ALREADY", 423: "E_FEATURE_OFF" }[status] || "E_REFUSED"; }
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await P().init();
      await runQuery(`CREATE TABLE IF NOT EXISTS user_sticker_packs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, pack_id TEXT NOT NULL, source TEXT NOT NULL,
        payer_id TEXT, price INTEGER NOT NULL DEFAULT 0, ref TEXT NOT NULL, period TEXT, routing TEXT, created INTEGER NOT NULL)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS user_sticker_packs_own ON user_sticker_packs (user_id, pack_id)");
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS user_sticker_packs_ref ON user_sticker_packs (ref)");
      await runQuery("CREATE INDEX IF NOT EXISTS user_sticker_packs_sp ON user_sticker_packs (user_id, source, period)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── ownership ──
async function ownedPacks(userId) {
  await init();
  if (!userId) return new Set();
  return new Set((await getQuery("SELECT pack_id FROM user_sticker_packs WHERE user_id = ?", [userId])).map((r) => r.pack_id));
}
async function owns(userId, packId) { return (await ownedPacks(userId)).has(packId); }
const periodKey = (t = now()) => new Date(t).toISOString().slice(0, 7);
/** The Season Pass allowance left this month: {per, used, left} (per 0 without a pass). */
async function allowance(userId, t = now()) {
  await init();
  const per = userId ? P().userPerks(userId).stickerPacks : 0;
  if (!per) return { per: 0, used: 0, left: 0, period: periodKey(t) };
  const used = (await getQuery("SELECT COUNT(*) AS n FROM user_sticker_packs WHERE user_id = ? AND source = 'season_pass' AND period = ?", [userId, periodKey(t)]))[0].n;
  return { per, used, left: Math.max(0, per - used), period: periodKey(t) };
}

/**
 * Get a pack. user = {userId, username}; opts = {pack, ref, to (username: a gift), allowance (true: use the Season
 * Pass allowance, own account only)}. Idempotent per (user, ref). -> {dup, pack, to, price, source}
 */
async function buy(user, opts = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const pack = CAT.byId[String(opts.pack || "")];
  if (!pack) throw new Refuse(404, "No such sticker pack.");
  if (pack.retired) throw new Refuse(410, "That pack isn't sold any more.");
  const rawRef = String(opts.ref || "");
  if (!REF_RE.test(rawRef)) throw new Refuse(400, "Bad request (ref).");
  const ref = `stk:${user.userId}:${rawRef}`;
  let to = { userId: user.userId, username: user.username };
  if (opts.to) {
    to = await P().userTarget(opts.to);
    if (!to) throw new Refuse(404, "No such account.");
  }
  const gift = to.userId !== user.userId;
  const useAllowance = !!opts.allowance;
  if (useAllowance && gift) throw new Refuse(400, "The Season Pass allowance is for your own packs.");
  if (!useAllowance && !P().config().sales) throw new Refuse(423, "Sticker packs aren't on sale right now.");
  const price = useAllowance ? 0 : priceOf(pack);
  const t = now();
  const out = await require("./boosts").tx(async () => {
    const had = (await getQuery("SELECT * FROM user_sticker_packs WHERE ref = ?", [ref]))[0];
    if (had) return { dup: true, row: had };
    if ((await getQuery("SELECT 1 FROM user_sticker_packs WHERE user_id = ? AND pack_id = ?", [to.userId, pack.id]))[0]) {
      throw new Refuse(409, gift ? `${to.username} already has ${pack.name}.` : `You already have ${pack.name}.`);
    }
    let period = null, routing = null;
    if (useAllowance) {
      const a = await allowance(user.userId, t);
      if (!a.per) throw new Refuse(403, "The free monthly pack comes with a 🎟️ Season Pass.");
      if (!a.left) throw new Refuse(409, "You've used this month's free pack - more next month.");
      period = a.period;
    } else {
      const r = await require("./ledger").post(user.userId, -price, `🧸 sticker pack${gift ? " gift" : ""}: ${pack.name}${gift ? " for " + to.username : ""}`.slice(0, 120),
                                               { requireCover: true, transactionId: P().txRef(ref), source: "stickers" });
      if (!r.ok) throw new Refuse(402, `${pack.name} costs ${fmt(price)} PAT - you don't have enough.`);
      routing = await P().bookRoute("stickers", price, { payerId: user.userId, label: `sticker pack ${pack.id}` });
    }
    await runQuery(`INSERT INTO user_sticker_packs (user_id, pack_id, source, payer_id, price, ref, period, routing, created)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                   [to.userId, pack.id, useAllowance ? "season_pass" : gift ? "gift" : "buy", user.userId, price, ref, period, routing ? JSON.stringify(routing) : null, t]);
    return { dup: false };
  });
  if (out.dup) return { dup: true, pack: pack.id, to: to.username, price: out.row.price, source: out.row.source };
  if (gift) {
    try {
      await require("./inbox").addSafe(to.userId, { kind: "cosmetics", ref: "stk-gift:" + ref, title: `🧸 ${user.username} gave you the ${pack.name} sticker pack`,
        body: "Use it in messages and posts - the 🧸 button in the composer.", link: "/premium#stickers" });
    } catch (e) { /* notice only */ }
  }
  return { dup: false, pack: pack.id, to: to.username, price, source: useAllowance ? "season_pass" : gift ? "gift" : "buy" };
}

// ── text ──
/** The [sticker:...] tokens in a text that name a real sticker: [{pack, sticker}] */
function tokens(text) {
  const out = [];
  const s = String(text || "");
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(s))) {
    const pk = CAT.byId[m[1]];
    if (pk && pk.byId[m[2]]) out.push({ pack: m[1], sticker: m[2] });
  }
  return out;
}
/** Refuse (throws) a text with a sticker from a pack the sender doesn't own, or too many stickers. */
async function validate(userId, text) {
  const tk = tokens(text);
  if (!tk.length) return true;
  if (tk.length > MAX_PER_TEXT) throw new Refuse(400, `At most ${MAX_PER_TEXT} stickers at a time.`);
  const mine = await ownedPacks(userId);
  const missing = [...new Set(tk.map((x) => x.pack))].filter((p) => !mine.has(p));
  if (missing.length) throw new Refuse(403, `You don't have the ${missing.map((p) => CAT.byId[p].name).join(", ")} sticker pack${missing.length > 1 ? "s" : ""} - get it on /premium.`);
  return true;
}
/** Already-escaped HTML in, known sticker tokens out as <img>s (a text that is ONLY stickers gets the big size). */
function inline(html) {
  const s = String(html == null ? "" : html);
  if (s.indexOf("[sticker:") < 0) return s;
  const only = s.replace(TOKEN_RE, "").replace(/<br>|\s/g, "") === "";
  TOKEN_RE.lastIndex = 0;
  return s.replace(TOKEN_RE, (all, p, k) => {
    const pk = CAT.byId[p], st = pk && pk.byId[k];
    if (!st) return all;
    return `<img class="stk${only ? " stk-l" : ""}" src="${st.url}" alt="${st.name}" title="${st.name} · ${pk.name}" width="${only ? 96 : 48}" height="${only ? 96 : 48}" style="image-rendering:pixelated;vertical-align:middle;max-width:100%;height:auto" loading="lazy" decoding="async">`;
  });
}

// ── reads ──
function catalog() {
  return CAT.packs.filter((p) => !p.retired).map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, desc: p.desc, price: priceOf(p),
    stickers: p.stickers.map((s) => ({ id: s.id, name: s.name, url: s.url, token: `[sticker:${p.id}/${s.id}]` })) }));
}
async function pageData(user) {
  await init();
  const signed = !!(user && user.userId);
  const mine = signed ? await ownedPacks(user.userId) : new Set();
  return { packs: catalog().map((p) => ({ ...p, owned: mine.has(p.id) })), signed, allowance: signed ? await allowance(user.userId) : null };
}

function register(app, { addUser }) {
  init().catch((e) => console.error("[stickers] init:", e.message));
  if (app.locals) app.locals.stickerHtml = inline;
  const guard = require("./middleware/authGuard");
  app.get("/api/stickers", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...(await pageData(req.user)) }); } catch (e) { const x = P().errBody(e); res.status(x.status).json(x.body); }
  });
  app.post("/api/stickers/buy", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    try {
      const b = req.body || {};
      const r = await buy(req.user, { pack: b.pack, ref: b.ref, to: b.to || null, allowance: b.allowance === true });
      res.json({ ok: true, ...r, state: await pageData(req.user) });
    } catch (e) { const x = P().errBody(e); res.status(x.status).json(x.body); }
  });
}

module.exports = {
  init, register, buy, ownedPacks, owns, allowance, tokens, validate, inline, catalog, pageData, loadCatalog, periodKey, Refuse, TOKEN_RE,
  chat: { validate, inline, TOKEN_RE },          // the hook for native PATV chat (later)
  get CAT() { return CAT; },
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
};
