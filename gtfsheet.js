// gtfsheet.js — 1.99rn: the heist character sheet on publicaccess.tv (/gtf/sheet/:login) and web re-rolls.
//
// Until now `!sheet` linked a page Pepe uploaded to his Netlify site (pepe.publicaccess.tv/sheet/...). The sheet lives
// here now, drawn from the same data in both modes of the GTF backend (gtfstore.js):
//   * backend ON  - the site's own records (gtf_records: kind sheet / pvp)
//   * backend OFF - a display MIRROR Pepe pushes (/api/gtf/bot/sheet-mirror -> gtf_mirror), like the gang board's
// plus Pepe's catalog (/api/gtf/bot/meta: the heist shop's names / emoji / prices, the re-roll prices, heat rules).
//
// Privacy: a player's profile layout decides (profilelayout.js): if they hide the "Grand Theft Frogger" section, only
// they and admins see the sheet page.
//
// Re-rolls from the web ("Re-roll sheet" / "Re-roll avatar", the owner only, a confirm step with the price):
//   * backend ON  - the site does it: ONE transaction debits the wallet with its routing intent (patroutes: flow
//                   sheetregen / avatarregen, so Pepe routes the PAT exactly like the chat command), writes the new
//                   sheet and queues a gtf_op Pepe applies to his mirror (he counts the re-roll achievements there).
//                   Keyed by the click's one-time key: a retry returns the first answer and never charges twice.
//   * backend OFF - a website action for Pepe (`!sheet regen` / `!avatar regen` as the linked Camfrog name, actions.js),
//                   the same chat command, rules and fees; he pushes the new sheet to the mirror right after.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const G = require("./gtfstore");

const STATS = ["str", "dex", "con", "int", "wis", "cha"];
const CLASS_BY_STAT = { str: "Muscle", dex: "Burglar", con: "Wheelman", int: "Hacker", wis: "Lookout", cha: "Face" };
const DEFAULT_PRICES = { sheetregen: 50000, avatarregen: 20000 };
const LOGIN_RE = /^[^\u0000-\u001f]{1,120}$/;
const IDEM_RE = /^[A-Za-z0-9_-]{8,64}$/;
// item art: the "use it" achievement badges show the items; the rest have their own pixel icons
const BADGE_ART = {
  lockpick: "cf_use_lockpick", breaching_charge: "cf_use_breach", painkillers: "cf_use_painkillers", hacking_rig: "cf_use_rig",
  scanner: "cf_use_scanner", fake_badge: "cf_use_badge", extra_clip: "cf_use_clip", thermite: "cf_use_thermite", uppers: "cf_use_uppers",
  cuffs: "cf_use_cuffs", bodydouble: "cf_use_double", driver: "cf_use_driver", lawyer: "cf_use_lawyer", ghost_plates: "cf_use_plates",
  smoke: "cf_use_smoke", schematics: "cf_use_schematics", alibi: "cf_use_alibi", adrenaline: "cf_use_adrenaline",
  secondwind: "cf_use_secondwind", hollow_points: "cf_use_hollow", nitrous: "cf_use_nitrous", loadeddice: "cf_relic_dice",
  kingpinring: "cf_relic_ring",
};
// 1.99ua (the user's rule): SOULBOUND relics - they belong to the player who found them and can never be listed, sold,
// pawned or delivered to anyone else (heistmarket.js). A HARD rule: this set (plus Pepe's catalog flag) - no admin setting
// makes one tradable. Loaded Dice and Vault Blueprints stay tradable.
const SOULBOUND = new Set(["kingpinring", "mastermind", "fence"]);
const isSoulbound = (key, it) => SOULBOUND.has(String(key)) || !!(it && it.soulbound === true);
const OWN_ART = new Set(["armor", "gun", "gloves", "knuckles", "blueprints", "mastermind", "fence"]);
const artFor = (k) => (BADGE_ART[k] ? `/public/img/badges/ach/${BADGE_ART[k]}.png` : OWN_ART.has(k) ? `/public/img/gtf/items/${k}.png` : null);

class Refuse extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || null; }
}
const now = () => Date.now();
const low = (s) => String(s || "").trim().replace(/^@+/, "").toLowerCase();

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await G.init();
      await runQuery(`CREATE TABLE IF NOT EXISTS gtf_mirror (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, display TEXT,
        updated INTEGER, PRIMARY KEY (kind, id))`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── Pepe's pushes ──
const isObjText = (t) => { if (typeof t !== "string" || t.length > 500000) return false; try { const v = JSON.parse(t); return !!v && typeof v === "object" && !Array.isArray(v); } catch (e) { return false; } };

/** The display mirror while GTF's data lives in Pepe. body {full, sheets: {login: text}, pvp: {login: text}, display: {login: name}} */
async function putMirror(b) {
  await init();
  const sheets = b && typeof b.sheets === "object" && b.sheets ? b.sheets : {};
  const pvp = b && typeof b.pvp === "object" && b.pvp ? b.pvp : {};
  const disp = b && typeof b.display === "object" && b.display ? b.display : {};
  const n = Object.keys(sheets).length + Object.keys(pvp).length;
  if (n > 20000) throw new Refuse(400, "mirror too large");
  const t = now();
  await G.tx(async () => {
    for (const [kind, set] of [["sheet", sheets], ["pvp", pvp]]) {
      for (const [id, text] of Object.entries(set)) {
        const k = low(id);
        if (!k || !LOGIN_RE.test(k) || !isObjText(text)) continue;
        await runQuery(`INSERT INTO gtf_mirror (kind, id, data, display, updated) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, display = COALESCE(excluded.display, gtf_mirror.display),
                        updated = excluded.updated`, [kind, k, text, disp[id] ? String(disp[id]).slice(0, 60) : null, t]);
      }
      if (b.full) {
        const keep = new Set(Object.keys(set).map(low));
        for (const r of await getQuery("SELECT id FROM gtf_mirror WHERE kind = ?", [kind])) {
          if (!keep.has(r.id)) await runQuery("DELETE FROM gtf_mirror WHERE kind = ? AND id = ?", [kind, r.id]);
        }
      }
    }
  });
  await G.setMeta("mirror_ts", t);
  const seeds = {};
  for (const [id, text] of Object.entries(sheets)) seeds[low(id)] = text;
  await G.syncAvatarSeeds(seeds).catch(() => {});
  return { ok: true, n };
}

/** Pepe's catalog: the heist shop, the re-roll prices and the heat rules (for drawing sheets). */
async function putCatalog(b) {
  await init();
  const c = b && b.catalog;
  if (!c || typeof c !== "object") throw new Refuse(400, "catalog required");
  const shop = {};
  for (const [k, it] of Object.entries(c.shop || {}).slice(0, 200)) {
    if (!/^[a-z0-9_]{1,30}$/.test(k) || !it) continue;
    shop[k] = { name: String(it.name || k).slice(0, 40), emoji: String(it.emoji || "").slice(0, 8), kind: String(it.kind || "item").slice(0, 10),
                cost: Math.max(0, Math.floor(Number(it.cost) || 0)), desc: String(it.desc || "").slice(0, 300), buyable: it.buyable !== false,
                game: String(it.game || "heist").slice(0, 10), soulbound: it.soulbound === true || SOULBOUND.has(k) };
  }
  const p = c.prices || {};
  const out = { shop, prices: { sheetregen: Math.max(0, Math.floor(Number(p.sheetregen) || DEFAULT_PRICES.sheetregen)),
                                avatarregen: Math.max(0, Math.floor(Number(p.avatarregen) || DEFAULT_PRICES.avatarregen)) },
                heat_max: Math.max(1, Math.floor(Number(c.heat_max) || 100)), heat_decay: Math.max(0, Number(c.heat_decay) || 40),
                levels_per_point: Math.max(1, Math.floor(Number(c.levels_per_point) || 10)), item_cap: Math.max(1, Math.floor(Number(c.item_cap) || 10)),
                at: now() };
  await G.setMeta("catalog", out);
  return { ok: true, items: Object.keys(shop).length };
}
async function catalog() {
  return (await G.meta("catalog")) || { shop: {}, prices: DEFAULT_PRICES, heat_max: 100, heat_decay: 40, levels_per_point: 10, item_cap: 10 };
}

// ── reading a sheet ──
/** {mode: "site"|"mirror"|null, sheet: text, pvp: text|null, display} */
async function source(login) {
  await init();
  const k = low(login);
  if (await G.live()) {
    const s = (await getQuery("SELECT data FROM gtf_records WHERE kind = 'sheet' AND id = ? AND deleted = 0", [k]))[0];
    const p = (await getQuery("SELECT data FROM gtf_records WHERE kind = 'pvp' AND id = ? AND deleted = 0", [k]))[0];
    return { mode: "site", sheet: s ? s.data : null, pvp: p ? p.data : null, display: null };
  }
  const s = (await getQuery("SELECT data, display, updated FROM gtf_mirror WHERE kind = 'sheet' AND id = ?", [k]))[0];
  const p = (await getQuery("SELECT data FROM gtf_mirror WHERE kind = 'pvp' AND id = ?", [k]))[0];
  return { mode: s ? "mirror" : null, sheet: s ? s.data : null, pvp: p ? p.data : null, display: s ? s.display : null, ts: s ? s.updated : null };
}

const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const modOf = (score) => Math.floor((int(score) - 10) / 2);

async function userFor(login) {
  return (await getQuery(`SELECT userId, username, displayname, camfrogUsername, level, class FROM users
                          WHERE LOWER(camfrogUsername) = LOWER(?) ORDER BY CASE WHEN camfrogUsername = ? THEN 0 ELSE 1 END LIMIT 1`, [login, login]))[0] || null;
}

/**
 * Everything the page draws, or {private: true} / {missing: true}. viewer: the signed-in userId (or null).
 */
async function view(login, viewer) {
  const k = low(login);
  if (!k || !LOGIN_RE.test(k)) return { missing: true, login: k };
  const [src, cat, u] = await Promise.all([source(k), catalog(), userFor(k)]);
  let isAdmin = false;
  if (viewer) isAdmin = SP.can((await getQuery("SELECT class FROM users WHERE userId = ?", [viewer]).catch(() => []))[0] || null, "profile.see_private");
  const owner = !!(u && viewer && u.userId === viewer);
  if (u) {
    const PL = require("./profilelayout");
    const v = PL.view(await PL.get(u.userId), { owner, admin: isAdmin });
    if (!v.show("gtf")) return { private: true, login: k, display: u.displayname || u.camfrogUsername || k };
  }
  if (!src.sheet) return { missing: true, login: k, mode: src.mode, owner, display: (u && (u.displayname || u.camfrogUsername)) || k };
  let sh;
  try { sh = JSON.parse(src.sheet); } catch (e) { return { missing: true, login: k }; }
  let pv = {};
  try { pv = src.pvp ? JSON.parse(src.pvp) : {}; } catch (e) { pv = {}; }
  const exact = G.topInts(src.sheet, ["loot", "heists", "busts", "cracks"]);
  const stats = STATS.map((s) => {
    const score = int((sh.stats || {})[s]);
    return { key: s, score, mod: modOf(score), best: sh.best_stat === s, pct: Math.max(0, Math.min(100, Math.round((score - 3) / 17 * 100))) };
  });
  // heat cools HEAT_DECAY per hour since heat_ts (as Pepe's _heist_heat)
  let heat = Number(sh.heat_val) || 0;
  if (sh.heat_ts) heat = Math.max(0, heat - (cat.heat_decay || 40) * Math.max(0, (now() / 1000 - Number(sh.heat_ts)) / 3600));
  heat = Math.min(cat.heat_max || 100, heat);
  const shop = cat.shop || {};
  const itemOf = (key, n) => {
    const it = shop[key] || {};
    return { key, n, name: it.name || key, emoji: it.emoji || "🎒", desc: it.desc || "", kind: it.kind || "item", art: artFor(key),
             cost: it.cost || 0, buyable: it.buyable !== false, soulbound: isSoulbound(key, it) };
  };
  const gear = (sh.gear || []).map((g) => itemOf(String(g), 1));
  const items = Object.entries(sh.items || {}).filter(([, n]) => int(n) > 0).map(([key, n]) => itemOf(key, int(n)))
    .sort((a, b) => (b.cost - a.cost) || a.name.localeCompare(b.name));
  const ringsBy = {};
  for (const r of sh.rings || []) { const st = String((r && r.stat) || "?").toLowerCase(); ringsBy[st] = (ringsBy[st] || 0) + 1; }
  const level = u ? int(u.level) : 0;
  const avail = u ? Math.max(0, Math.floor(level / (cat.levels_per_point || 10)) - int(sh.spent_points)) : null;
  let layers = {};
  if (u) {
    try {
      const eq = await require("./cosmetics").equippedFor(u.userId);
      for (const [kind, x] of Object.entries(eq || {})) if (/^gtf_/.test(kind) && x && x.r && x.r.layer) layers[kind.slice(4)] = x.r.layer;
    } catch (e) { layers = {}; }
  }
  return {
    login: k, mode: src.mode, mirror_ts: src.ts || null, owner,
    display: (u && (u.displayname || u.camfrogUsername)) || src.display || k, username: u ? u.username : null, level,
    cls: sh.class || "Crook", best: sh.best_stat || null, created: sh.created || null, stats, avail,
    record: { heists: String(exact.heists || 0n), busts: String(exact.busts || 0n), cracks: String(exact.cracks || 0n), loot: String(exact.loot || 0n),
              deepest: int(sh.deepest), done: ["store", "casino", "convoy", "bank"].filter((j) => sh["done_" + j]) },
    heat: Math.round(heat), heat_max: cat.heat_max || 100,
    pvp: { duels: { w: int(pv.wins), l: int(pv.losses), net: int(pv.net) },
           brawls: { w: int(sh.brawl_wins), l: int(sh.brawl_losses), net: int(sh.brawl_net) }, arena: int(sh.arena_wins) },
    gear, items, rings: { n: (sh.rings || []).length, by: ringsBy },
    avatar: { seed: int(sh.avatar_seed) || 7, layers },
    prices: cat.prices || DEFAULT_PRICES,
  };
}

// ── re-rolls ──
function roll4d6() {
  const r = [0, 0, 0, 0].map(() => 1 + crypto.randomInt(6)).sort((a, b) => a - b);
  return r[1] + r[2] + r[3];
}
/** Where each top-level value of a JSON object's text sits: {key: [start, end)} (strings / nesting skipped). */
function topSpans(text) {
  const out = {};
  let i = text.indexOf("{") + 1;
  const n = text.length;
  const ws = () => { while (i < n && /\s/.test(text[i])) i++; };
  const skipString = () => { i++; while (i < n && text[i] !== '"') i += text[i] === "\\" ? 2 : 1; i++; };
  const skipValue = () => {
    ws();
    if (text[i] === '"') return skipString();
    if (text[i] === "{" || text[i] === "[") {
      let depth = 0;
      while (i < n) {
        const c = text[i];
        if (c === '"') { skipString(); continue; }
        if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") { depth--; if (depth === 0) { i++; return; } }
        i++;
      }
      return;
    }
    while (i < n && !/[,}\]\s]/.test(text[i])) i++;
  };
  while (i < n) {
    ws();
    if (text[i] !== '"') break;
    const ks = i;
    skipString();
    const key = JSON.parse(text.slice(ks, i));
    ws();
    if (text[i] !== ":") break;
    i++;
    ws();
    const vs = i;
    skipValue();
    out[key] = [vs, i];
    ws();
    if (text[i] === ",") { i++; continue; }
    break;
  }
  return out;
}
/** Set top-level keys of a JSON object's text to these values (JSON texts), leaving every other byte as it is - so the
 *  numbers Pepe stores past 2^53 (loot) are never re-serialized by JS. Missing keys are appended. */
function setTopKeys(text, vals) {
  const spans = topSpans(text);
  const edits = Object.entries(vals).filter(([k]) => spans[k]).map(([k, v]) => [spans[k][0], spans[k][1], v]).sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [s, e, v] of edits) out = out.slice(0, s) + v + out.slice(e);
  const add = Object.entries(vals).filter(([k]) => !spans[k]).map(([k, v]) => JSON.stringify(k) + ":" + v);
  if (add.length) {
    const end = out.lastIndexOf("}");
    const body = out.slice(0, end).trimEnd();
    out = body + (body.endsWith("{") ? "" : ",") + add.join(",") + out.slice(end);
  }
  return out;
}
/** The new sheet text for a sheet re-roll (Pepe's _heist_regen_sheet, 1.99rn): new stats + class, spent points back, every
 *  used Kingpin's Ring back into the bag; everything else on the sheet (record, gear, items, heat, fights) stays. */
function regenText(oldText, stats) {
  const old = JSON.parse(oldText);
  const best = STATS.reduce((b, s) => (stats[s] > stats[b] ? s : b), STATS[0]);      // the first highest, as Python's max()
  const rings = Array.isArray(old.rings) ? old.rings : [];
  const vals = { stats: JSON.stringify(stats), best_stat: JSON.stringify(best), class: JSON.stringify(CLASS_BY_STAT[best]), spent_points: "0" };
  if (rings.length) {
    const items = Object.assign({}, old.items || {});
    items.kingpinring = int(items.kingpinring) + rings.length;                          // every ring's +1 is gone: hand them back
    vals.items = JSON.stringify(items);
    vals.rings = "[]";
  }
  return { text: setTopKeys(oldText, vals), fields: { stats, best_stat: best, class: CLASS_BY_STAT[best] }, rings_back: rings.length };
}
/** The avatar re-roll: only avatar_seed changes. */
function avatarText(oldText, seed) {
  return setTopKeys(oldText, { avatar_seed: String(seed) });
}

async function reroll(userId, { what, idem }) {
  await init();
  if (what !== "sheet" && what !== "avatar") throw new Refuse(400, "Re-roll the sheet or the avatar.");
  if (!IDEM_RE.test(String(idem || ""))) throw new Refuse(400, "Bad request (key).");
  const u = (await getQuery("SELECT userId, username, camfrogUsername FROM users WHERE userId = ?", [userId]))[0];
  if (!u) throw new Refuse(401, "Sign in first.");
  if (!u.camfrogUsername) throw new Refuse(409, "Link a chat account first (Settings → Account → Connections; for Camfrog, type !verify in a room with Pepe) - the sheet belongs to it.", "E_NOT_LINKED");
  const login = low(u.camfrogUsername);
  const cat = await catalog();
  const flow = what === "sheet" ? "sheetregen" : "avatarregen";
  const price = Math.max(0, Math.floor(Number((cat.prices || {})[flow]) || DEFAULT_PRICES[flow]));
  if (!(await G.live())) {
    // GTF data lives in Pepe: the same chat command, run by him as this Camfrog name (rules, fee, achievements)
    const id = await require("./actions").queue(userId, { kind: "cmd", args: [what, "regen"], tag: "gtf",
                                                         label: what === "sheet" ? "Re-roll sheet" : "Re-roll avatar", idem });
    return { ok: true, mode: "pepe", queued: id, price };
  }
  const key = `gw-${what}-${userId}-${idem}`;
  const done = (await getQuery("SELECT op, fields, price FROM gtf_ops WHERE key = ?", [key]))[0];
  if (done) return { ok: true, mode: "site", already: true, price: done.price, view: await view(login, userId) };
  const ledger = require("./ledger");
  const patroutes = require("./patroutes");
  await patroutes.init();
  let rings = 0;
  await G.tx(async () => {
    if ((await getQuery("SELECT 1 FROM gtf_ops WHERE key = ?", [key])).length) return;      // its twin got here first
    const rec = (await getQuery("SELECT data FROM gtf_records WHERE kind = 'sheet' AND id = ? AND deleted = 0", [login]))[0];
    if (!rec) throw new Refuse(404, "You don't have a sheet yet - type !sheet in a Camfrog room to roll your first one (free).", "E_NO_SHEET");
    let next, fields;
    if (what === "sheet") {
      const stats = {};
      for (const s of STATS) stats[s] = roll4d6();
      const r = regenText(rec.data, stats);
      next = r.text; fields = r.fields; rings = r.rings_back;
    } else {
      const seed = 1 + crypto.randomInt(2 ** 31 - 2);
      next = avatarText(rec.data, seed); fields = { avatar_seed: seed };
    }
    if (price > 0) {
      const d = await ledger.post(userId, -price, what === "sheet" ? "sheet-regen" : "avatar-regen", { requireCover: true, source: "gtf/web-reroll" });
      if (!d.ok) {
        throw d.code === ledger.E_INSUFFICIENT ? new Refuse(402, `That costs ${price.toLocaleString("en-US")} PAT - you don't have enough.`, "E_INSUFFICIENT_PAT")
          : new Refuse(404, "Couldn't find your account.");
      }
      await patroutes.recordInTx(key, { userId, username: u.username, amount: price, reason: what === "sheet" ? "sheet-regen" : "avatar-regen",
                                        txid: d.transactionId }, { flow, room: null, payer: login, item_sink: null });
    }
    const rev = ((await G.meta("rev")) || 0) + 1;
    await runQuery("UPDATE gtf_records SET data = ?, rev = ?, updated = ? WHERE kind = 'sheet' AND id = ?", [next, rev, now(), login]);
    await G.setMeta("rev", rev);
    await runQuery("INSERT INTO gtf_ops (key, login, op, fields, user_id, price, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
                   [key, login, what === "sheet" ? "regen_sheet" : "regen_avatar", JSON.stringify(fields), userId, price, now()]);
  });
  if (what === "avatar") {
    const r = (await getQuery("SELECT data FROM gtf_records WHERE kind = 'sheet' AND id = ?", [login]))[0];
    if (r) await G.syncAvatarSeeds({ [login]: r.data }).catch(() => {});
  }
  return { ok: true, mode: "site", price, rings_back: rings, view: await view(login, userId) };
}

/** The status of a queued web re-roll (backend off). */
async function actionStatus(userId, id) {
  const r = (await getQuery("SELECT status, message FROM pepe_actions WHERE id = ? AND user_id = ?", [Math.floor(Number(id)) || 0, userId]).catch(() => []))[0];
  return r ? { ok: true, status: r.status, message: r.message || "" } : { ok: false, error: "not found" };
}

/** The sheet link for a Camfrog login (the profile, /gtf, gangs ... all link here now). */
const urlFor = (login) => `/gtf/sheet/${encodeURIComponent(low(login))}`;

async function hasSheet(login) {
  const s = await source(login).catch(() => null);
  if (!s || !s.sheet) return null;
  try { const sh = JSON.parse(s.sheet); return { url: urlFor(login), cls: sh.class || "" }; } catch (e) { return { url: urlFor(login), cls: "" }; }
}

function register(app, { isBotToken, addUser }) {
  init().catch((e) => console.error("[gtfsheet] init:", e.message));
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) {
      if (e instanceof Refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code });
      console.error("[gtfsheet] bot:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  };
  app.post("/api/gtf/bot/sheet-mirror", require("express").json({ limit: "32mb" }), bot((b) => putMirror(b)));
  app.post("/api/gtf/bot/meta", bot((b) => putCatalog(b)));
  const uid = (req) => (req.user && req.user.userId) || null;
  app.get("/gtf/sheet/:login", addUser, async (req, res) => {
    try {
      const v = await view(req.params.login, uid(req));
      res.status(v.missing || v.private ? 404 : 200).render("gtfsheet", { user: req.user ? req.user.username : null, v, signedIn: !!uid(req) });
    } catch (e) { console.error("[gtfsheet] page:", e); res.status(500).send("Something went wrong."); }
  });
  app.get("/api/gtf/sheet/:login", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json(Object.assign({ ok: true }, await view(req.params.login, uid(req)))); } catch (e) { res.status(500).json({ ok: false }); }
  });
  app.get("/gtf/sheet", addUser, async (req, res) => {
    // "my sheet": the signed-in user's linked Camfrog name
    const u = uid(req) ? (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [uid(req)]))[0] : null;
    if (u && u.camfrogUsername) return res.redirect(302, urlFor(u.camfrogUsername));
    res.redirect(302, "/gtf");
  });
  app.post("/api/gtf/sheet/reroll", addUser, async (req, res) => {
    if (!uid(req)) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    try { res.json(await reroll(uid(req), req.body || {})); } catch (e) {
      if (e instanceof Refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code });
      if (/duplicate|busy/i.test(String(e.message))) return res.status(409).json({ ok: false, error: "That re-roll is already on its way." });
      console.error("[gtfsheet] reroll:", e);
      res.status(500).json({ ok: false, error: "Something went wrong - nothing was charged." });
    }
  });
  app.get("/api/gtf/sheet-action/:id", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!uid(req)) return res.status(401).json({ ok: false });
    res.json(await actionStatus(uid(req), req.params.id));
  });
}

module.exports = { SOULBOUND, isSoulbound, init, register, view, reroll, putMirror, putCatalog, catalog, source, regenText, avatarText, setTopKeys, topSpans, urlFor, hasSheet, Refuse, STATS, artFor };
