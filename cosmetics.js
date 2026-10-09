// cosmetics.js — PATV cosmetics: account looks (name colors, profile borders/banners/effects, avatar
// decorations) and Grand Theft Frogger pixel-avatar layers, plus the badge showcase.
//
// The catalog is cosmetics.json. Every owned item is a COPY (a row in user_cosmetics) so copies can
// be traded: an owner can equip it, list it on the player market, cancel the listing, or gift it.
// None of that touches PAT. Anything that costs PAT (shop purchase, gifting a new item, buying a
// listing) is queued as a website action and run by Pepe as the user; Pepe charges, then calls the
// bot API here (grant / transfer). Achievement and level unlocks are granted here directly.
//
// Bot API (POST, bot token in `password`, all idempotent):
//   /api/cosmetics/grant      {user, item, source, idem}            -> {ok, inv_id, already}
//   /api/cosmetics/transfer   {inv_id, from, to, idem, listing_id?} -> {ok} | {ok:false, error}
//   /api/cosmetics/listing    {id}                                  -> {listing, item, seller}
//   /api/cosmetics/inventory  {user}                                -> {items, equipped}
//   /api/cosmetics/equip      {user, item_id|inv_id|kind, on}       -> {ok}
//   /api/cosmetics/seed       {camfrog, seed}                       -> {ok}   (GTF avatar seed, for previews)
//   /api/cosmetics/drop-config {rates: {wheel, wheel_jackpot}, cap}  -> {ok}   (Pepe owns the drop table)
// grant takes an optional `cap`: an "odrop-" (organic drop) grant is refused with error "daily_cap" once
// the user already got `cap` organic drops in the last 24h (Pepe's events and the wheel share it).
// `user` / `from` / `to` are {username} (PATV) or {camfrog} (Camfrog name), case-insensitive.
// Public: GET /api/cosmetics/catalog, GET /api/cosmetics/equipped/:camfrog
// 1.99iv SEASON PASS perks (premium.js): items with "perk": "season_pass" (source ["season_pass"], never sold) are
// granted into the inventory when a Season Pass starts (grantSeasonPerks); they can't be listed, gifted or
// transferred, can only be equipped while the pass is on, and stop rendering when it lapses (they come back with it).
const fs = require("fs");
const path = require("path");
const { runQuery, getQuery } = require("./dbUtils");

// ── catalog ──
const CATALOG_FILE = path.join(__dirname, "cosmetics.json");
let CAT = { rarities: {}, kinds: {}, items: [] };
try {
  CAT = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
} catch (e) {
  console.error("[cosmetics] catalog:", e.message);
}
let ACH_NAME = {};
try {
  for (const a of JSON.parse(fs.readFileSync(path.join(__dirname, "achievements.json"), "utf8")).achievements || []) ACH_NAME[a.id] = a.name;
} catch (e) { ACH_NAME = {}; }
const ITEMS = (CAT.items || []).filter((i) => i && i.id && i.kind);
const BY_ID = Object.fromEntries(ITEMS.map((i) => [i.id, i]));
const KINDS = Object.keys(CAT.kinds || {});
const ACCOUNT_KINDS = ["name_color", "profile_border", "avatar_decoration", "profile_banner", "profile_effect"];
const GTF_KINDS = ["gtf_hat", "gtf_mask", "gtf_outfit", "gtf_prop", "gtf_bg", "gtf_frame"];
const GTF_OPT = { gtf_hat: "hat", gtf_mask: "mask", gtf_outfit: "outfit", gtf_prop: "prop", gtf_bg: "bg", gtf_frame: "frame" };
const GTF_LAYERS = {
  gtf_hat: ["crown", "tophat", "cowboy", "beanie", "halo", "horns", "party", "chef", "viking", "pirate",
            "beehive", "tiara", "rainbowwig", "muir", "bow", "catears", "bunny", "flowercrown", "bountyhat", "lotus"],
  gtf_mask: ["balaclava", "domino", "sunglasses", "monocle", "eyepatch", "bandana", "lashes", "puphood", "heartshades"],
  gtf_outfit: ["suit", "hoodie", "prison", "tuxedo", "goldchain", "bandolier",
               "sequin", "boa", "harness", "collar", "latex", "sundress", "cardigan", "pridecape"],
  gtf_prop: ["cigar", "moneybag", "crowbar", "briefcase", "rose", "dice",
             "prideflag", "discoball", "flamingo", "fan", "cuffs", "crop", "boba", "strawberry", "plushie", "sheriffstar"],
  gtf_bg: ["vault", "neon", "city", "jail", "sunset", "matrix",
           "progress", "intersex", "trans", "bi", "lesbian", "pan", "enby", "ace", "aro", "genderfluid",
           "lavalamp", "leopard", "redroom", "sakura", "clouds", "wanted", "lilypond"],
  gtf_frame: ["gold", "diamond", "flame", "neon", "pixel", "glitter", "rainbow", "chain", "hearts", "rope", "laurel"],
};
const LAYER_EMOJI = {
  crown: "👑", tophat: "🎩", cowboy: "🤠", beanie: "🧢", halo: "😇", horns: "😈", party: "🥳", chef: "👨‍🍳", viking: "🪓", pirate: "🏴‍☠️",
  balaclava: "🥷", domino: "🎭", sunglasses: "🕶️", monocle: "🧐", eyepatch: "🏴‍☠️", bandana: "🤠",
  suit: "🕴️", hoodie: "🧥", prison: "🟧", tuxedo: "🤵", goldchain: "📿", bandolier: "🎖️",
  cigar: "🚬", moneybag: "💰", crowbar: "🔧", briefcase: "💼", rose: "🌹", dice: "🎲",
  vault: "🏦", neon: "🌃", city: "🏙️", jail: "🚔", sunset: "🌅", matrix: "💻",
  gold: "🟨", diamond: "💎", flame: "🔥", pixel: "👾",
  beehive: "👱‍♀️", tiara: "👸", rainbowwig: "🌈", muir: "🧢", bow: "🎀", catears: "🐱", bunny: "🐰", flowercrown: "🌸",
  lashes: "💄", puphood: "🐶", heartshades: "😍",
  sequin: "👗", boa: "🪶", harness: "⛓️", collar: "📿", latex: "🖤", sundress: "👗", cardigan: "🧶", pridecape: "🏳️‍🌈",
  prideflag: "🏳️‍🌈", discoball: "🪩", flamingo: "🦩", fan: "🪭", cuffs: "🔗", crop: "🏇", boba: "🧋", strawberry: "🍓", plushie: "🧸",
  progress: "🏳️‍🌈", intersex: "🏳️‍🌈", trans: "🏳️‍⚧️", bi: "💗", lesbian: "🧡", pan: "💛", enby: "💜", ace: "🖤", aro: "💚", genderfluid: "🌊",
  lavalamp: "🫧", leopard: "🐆", redroom: "🟥", sakura: "🌸", clouds: "☁️",
  glitter: "✨", rainbow: "🌈", chain: "⛓️", hearts: "💖",
  bountyhat: "🤠", sheriffstar: "⭐", wanted: "📜", rope: "🪢",
  lotus: "🪷", lilypond: "🌙", laurel: "🌿",
};
const EFFECTS = ["sparkle", "snow", "embers", "confetti", "matrix", "hearts", "disco", "pridefetti"];
const TAGS = CAT.tags || {};
for (const it of ITEMS) {                                 // catch typos at boot, don't crash
  if (!KINDS.includes(it.kind)) console.error(`[cosmetics] ${it.id}: unknown kind ${it.kind}`);
  if (GTF_LAYERS[it.kind] && !GTF_LAYERS[it.kind].includes((it.style || {}).layer)) console.error(`[cosmetics] ${it.id}: bad layer`);
  if (it.unlock && it.unlock.achievement && Object.keys(ACH_NAME).length && !ACH_NAME[it.unlock.achievement]) console.error(`[cosmetics] ${it.id}: unknown achievement`);
  if (it.kind === "profile_effect" && !EFFECTS.includes((it.style || {}).effect)) console.error(`[cosmetics] ${it.id}: bad effect`);
  for (const t of it.tags || []) if (!TAGS[t]) console.error(`[cosmetics] ${it.id}: unknown tag ${t}`);
}

const MARKET_FEE_PCT = 5;            // Pepe takes it on a market sale; shown on the site
const LIST_MIN = 1000;
const LIST_MAX = 10000000000;
const MAX_LISTINGS = 20;
const SHOWCASE_MAX = 3;

const dayMs = (d) => Date.parse(String(d) + "T00:00:00Z");
/** 'active' | 'upcoming' | 'over' for a seasonal item, null otherwise. */
function seasonState(item, now = Date.now()) {
  if (!item || !item.season) return null;
  const from = dayMs(item.season.from), to = dayMs(item.season.to);
  if (now < from) return "upcoming";
  if (now >= to) return "over";
  return "active";
}
/** Can it be bought in Pepe's shop right now? */
function onSale(item, now = Date.now()) {
  if (!item || !(item.price > 0)) return false;
  const src = item.source || [];
  if (item.season) return src.includes("season") && seasonState(item, now) === "active";
  return src.includes("shop");
}

// 1.99iv: Season Pass perk items (premium.js)
const isPerk = (it) => !!it && it.perk === "season_pass";
const passOn = (userId) => { try { return require("./premium").hasPass(userId); } catch (e) { return false; } };
const perkLive = (it, userId) => !isPerk(it) || passOn(userId);
const PERK_IDS = ITEMS.filter(isPerk).map((i) => i.id);

// ── rendering (inline CSS from the catalog's style data) ──
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cssSafe = (s) => String(s == null ? "" : s).replace(/[<>"{}]/g, "");

function nameCss(item) {
  const s = (item && item.style) || {};
  if (Array.isArray(s.gradient) && s.gradient.length) {
    const g = s.gradient.map(cssSafe).join(", ");
    return `background: linear-gradient(90deg, ${g}); background-size: ${s.animate ? "200% 100%" : "100% 100%"}; ` +
      "-webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-fill-color: transparent;" +
      (s.animate ? " animation: cx-shift 6s linear infinite;" : "");
  }
  return s.color ? `color: ${cssSafe(s.color)};` : "";
}

/** Everything a template needs to draw one item. */
function render(item) {
  if (!item) return null;
  const s = item.style || {};
  const r = { id: item.id, kind: item.kind, name: item.name, rarity: item.rarity };
  switch (item.kind) {
    case "name_color": r.css = nameCss(item); break;
    case "profile_border":
      r.css = cssSafe(s.css);
      r.cls = s.hue ? "cx-frame-hue" : s.animated ? "cx-frame-pulse" : "";
      break;
    case "avatar_decoration":
      r.ring = cssSafe(s.ring || "");
      r.conic = Array.isArray(s.conic) ? `background: conic-gradient(${s.conic.map(cssSafe).join(", ")});` : "";
      r.spin = !!s.spin;
      r.emoji = s.emoji || "";
      break;
    case "profile_banner": r.css = `background: ${cssSafe(s.background)};`; break;
    case "profile_effect": r.effect = EFFECTS.includes(s.effect) ? s.effect : "sparkle"; break;
    default:
      if (GTF_OPT[item.kind]) { r.layer = s.layer; r.opt = GTF_OPT[item.kind]; r.emoji = LAYER_EMOJI[s.layer] || "🐸"; }
  }
  return r;
}

// ── tables ──
const ready = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS user_cosmetics (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, item_id TEXT NOT NULL, source TEXT,
    acquired INTEGER, idem TEXT UNIQUE, locked INTEGER DEFAULT 0)`);
  await runQuery("CREATE INDEX IF NOT EXISTS idx_user_cosmetics_user ON user_cosmetics (user_id)");
  await runQuery(`CREATE TABLE IF NOT EXISTS user_cosmetic_equips (
    user_id TEXT NOT NULL, kind TEXT NOT NULL, inv_id INTEGER NOT NULL, PRIMARY KEY (user_id, kind))`);
  await runQuery(`CREATE TABLE IF NOT EXISTS cosmetic_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, inv_id INTEGER NOT NULL, seller_id TEXT NOT NULL, price INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', created INTEGER, updated INTEGER, buyer_id TEXT)`);
  await runQuery("CREATE INDEX IF NOT EXISTS idx_cosmetic_listings_status ON cosmetic_listings (status)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_badge_showcase (user_id TEXT PRIMARY KEY, badges TEXT)");
  await runQuery(`CREATE TABLE IF NOT EXISTS cosmetic_transfers (
    idem TEXT PRIMARY KEY, inv_id INTEGER, from_id TEXT, to_id TEXT, listing_id INTEGER, created INTEGER)`);
  await runQuery("CREATE TABLE IF NOT EXISTS cosmetic_avatar_seeds (camfrog TEXT PRIMARY KEY, seed INTEGER, updated INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS cosmetic_drop_config (key TEXT PRIMARY KEY, value REAL, updated INTEGER)");
})().catch((e) => console.error("[cosmetics] tables:", e));

// ── users ──
/** {userId} | {username} | {camfrog} (or a bare string, tried as both) -> users row or null. */
async function resolveUser(who) {
  await ready;
  if (!who) return null;
  if (typeof who === "string") who = { name: who };
  const cols = "userId, username, displayname, camfrogUsername, points_balance, level, avatar";
  if (who.userId) {
    const r = await getQuery(`SELECT ${cols} FROM users WHERE userId = ?`, [String(who.userId)]);
    if (r.length) return r[0];
  }
  if (who.username) {
    const r = await getQuery(`SELECT ${cols} FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1`, [String(who.username).trim()]);
    if (r.length) return r[0];
  }
  const name = String(who.camfrog || who.camfrogUsername || who.name || "").trim().replace(/^@/, "");
  if (!name) return null;
  // Same preference as achievements.js: a linked Camfrog name first, then the real account over a
  // Pepe-made CF placeholder.
  const r = await getQuery(
    `SELECT ${cols} FROM users WHERE LOWER(camfrogUsername) = LOWER(?) OR LOWER(username) = LOWER(?)
     ORDER BY CASE WHEN LOWER(camfrogUsername) = LOWER(?) THEN 0 ELSE 1 END,
              CASE WHEN username LIKE 'CF%' THEN 1 ELSE 0 END LIMIT 1`, [name, name, name]);
  return r.length ? r[0] : null;
}

// ── name color cache (username -> css), shared by every page ──
const NAME_TTL = 60 * 1000;
let nameCache = new Map(), nameAt = 0, nameLoading = null;
async function loadNames() {
  await ready;
  const rows = await getQuery(
    `SELECT u.username, c.item_id, e.user_id FROM user_cosmetic_equips e
     JOIN user_cosmetics c ON c.id = e.inv_id AND c.user_id = e.user_id AND c.locked = 0
     JOIN users u ON u.userId = e.user_id WHERE e.kind = 'name_color'`);
  const m = new Map();
  for (const r of rows) {
    if (!perkLive(BY_ID[r.item_id], r.user_id)) continue;           // 1.99iv: a lapsed Season Pass's name style
    const css = nameCss(BY_ID[r.item_id]);
    if (css) m.set(String(r.username).toLowerCase(), css);
  }
  nameCache = m; nameAt = Date.now();
}
function refreshNames(force) {
  if (!force && Date.now() - nameAt < NAME_TTL) return Promise.resolve();
  if (!nameLoading) nameLoading = loadNames().catch((e) => console.error("[cosmetics] names:", e.message)).finally(() => { nameLoading = null; });
  return nameLoading;
}
const invalidateNames = () => { nameAt = 0; };
/** Sync lookup from the cache (refreshes in the background when stale). */
function nameStyle(username) {
  refreshNames();
  return (username && nameCache.get(String(username).toLowerCase())) || "";
}
/** {username: cssStyleString} for the given names (only those with a name color). */
async function nameStyles(usernames) {
  await refreshNames();
  const out = {};
  for (const u of usernames || []) { const s = nameStyle(u); if (s) out[u] = s; }
  return out;
}
/** A <span> with the user's name color (escaped). */
function nameHtml(username, display) {
  const s = nameStyle(username);
  const text = esc(display == null ? username : display);
  return s ? `<span class="cx-name" style="${esc(s)}">${text}</span>` : text;
}

// ── inventory ──
async function inventory(userId) {
  await ready;
  const rows = await getQuery(
    `SELECT c.id, c.item_id, c.source, c.acquired, c.locked,
            (SELECT l.id FROM cosmetic_listings l WHERE l.inv_id = c.id AND l.status = 'active' LIMIT 1) AS listing_id,
            (SELECT l.price FROM cosmetic_listings l WHERE l.inv_id = c.id AND l.status = 'active' LIMIT 1) AS listing_price
     FROM user_cosmetics c WHERE c.user_id = ? ORDER BY c.id`, [userId]);
  const eq = await getQuery(
    `SELECT e.kind, e.inv_id, c.item_id FROM user_cosmetic_equips e
     JOIN user_cosmetics c ON c.id = e.inv_id AND c.user_id = e.user_id AND c.locked = 0 WHERE e.user_id = ?`, [userId]);
  const equippedInv = new Set(eq.map((e) => e.inv_id));
  const equipped = {};
  for (const e of eq) if (BY_ID[e.item_id]) equipped[e.kind] = e.item_id;
  const items = rows.filter((r) => BY_ID[r.item_id]).map((r) => ({
    inv_id: r.id, item_id: r.item_id, kind: BY_ID[r.item_id].kind, name: BY_ID[r.item_id].name,
    rarity: BY_ID[r.item_id].rarity, source: r.source, acquired: r.acquired, locked: !!r.locked,
    perk: isPerk(BY_ID[r.item_id]) ? "season_pass" : null, perk_off: isPerk(BY_ID[r.item_id]) && !passOn(userId),
    equipped: equippedInv.has(r.id), listing_id: r.listing_id || null, listing_price: r.listing_price || null,
  }));
  return { items, equipped };
}

/** Equipped items for a user: {kind: {item_id, item, r (render)}} */
async function equippedFor(userId) {
  await ready;
  const eq = await getQuery(
    `SELECT e.kind, c.item_id FROM user_cosmetic_equips e
     JOIN user_cosmetics c ON c.id = e.inv_id AND c.user_id = e.user_id AND c.locked = 0 WHERE e.user_id = ?`, [userId]);
  const out = {};
  for (const e of eq) {
    const it = BY_ID[e.item_id];
    if (it && it.kind === e.kind && perkLive(it, userId)) out[e.kind] = { item_id: it.id, item: it, r: render(it) };
  }
  return out;
}

async function grant(userId, itemId, source, idem) {
  await ready;
  const it = BY_ID[itemId];
  if (!it) return { ok: false, error: "unknown item" };
  if (!idem) return { ok: false, error: "idem required" };
  const ins = await runQuery("INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, source, acquired, idem, locked) VALUES (?, ?, ?, ?, ?, 0)",
    [userId, it.id, String(source || "grant").slice(0, 30), Date.now(), String(idem).slice(0, 200)]);
  if (ins && ins.changes) return { ok: true, inv_id: ins.id, already: false };
  const prev = await getQuery("SELECT id FROM user_cosmetics WHERE idem = ?", [String(idem).slice(0, 200)]);
  return { ok: true, inv_id: prev.length ? prev[0].id : null, already: true };
}

// ── drops ──
// Pepe owns the drop table (pepe_cosmetics.py) and rolls every game drop himself. The wheel is settled
// here, so its two rows (and the daily cap) are pushed to us; these defaults match his until he does.
const DROP_DEFAULTS = { wheel: 0.0005, wheel_jackpot: 0.25, cap: 3 };
const DROP_GROUPS = {
  heist: ["crack", "door", "store", "convoy"],
  fight: ["arena", "duel", "brawl"],
  casino: ["blackjack", "holdem", "wheel", "wheel_jackpot", "lotto", "lotto_jackpot", "bingo", "bingo_line"],
};
const RARITY_ORDER = ["common", "uncommon", "rare", "epic", "legendary"];
const DAY_MS = 24 * 3600 * 1000;
let dropCfg = null, dropCfgAt = 0;

async function dropConfig() {
  if (dropCfg && Date.now() - dropCfgAt < 60000) return dropCfg;
  await ready;
  const cfg = { ...DROP_DEFAULTS };
  try {
    for (const r of await getQuery("SELECT key, value FROM cosmetic_drop_config")) {
      if (r.key in cfg && Number.isFinite(Number(r.value))) cfg[r.key] = Number(r.value);
    }
  } catch (e) { /* defaults */ }
  dropCfg = cfg; dropCfgAt = Date.now();
  return cfg;
}

async function setDropConfig(rates, cap) {
  await ready;
  const now = Date.now();
  for (const k of ["wheel", "wheel_jackpot"]) {
    const v = Number((rates || {})[k]);
    if (Number.isFinite(v)) {
      await runQuery(`INSERT INTO cosmetic_drop_config (key, value, updated) VALUES (?, ?, ?)
                      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated`,
        [k, Math.max(0, Math.min(1, v)), now]);
    }
  }
  const c = Number(cap);
  if (Number.isFinite(c)) {
    await runQuery(`INSERT INTO cosmetic_drop_config (key, value, updated) VALUES ('cap', ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated`,
      [Math.max(0, Math.min(50, Math.floor(c))), now]);
  }
  dropCfgAt = 0;
}

/** Same pool rules as Pepe's _cos_pick: drop items only (never shop-only, achievement-only or
 *  seasonal), weighted; items with drop_events only from matching events (half of that event's drops). */
function pickDrop(event, minRarity) {
  let pool = ITEMS.filter((it) => (it.source || []).includes("drop") && Number(it.drop_weight) > 0 && !it.season
    && !(it.tags || []).includes("kink"));
  if (minRarity && RARITY_ORDER.includes(minRarity)) {
    const floor = RARITY_ORDER.indexOf(minRarity);
    pool = pool.filter((it) => RARITY_ORDER.indexOf(String(it.rarity || "").toLowerCase()) >= floor);
  }
  const ev = String(event);
  const tags = new Set([ev, ev.split("_")[0]]);
  for (const [g, evs] of Object.entries(DROP_GROUPS)) if (evs.includes(ev)) tags.add(g);
  const general = pool.filter((it) => !(it.drop_events || []).length);
  const special = pool.filter((it) => (it.drop_events || []).some((t) => tags.has(t)));
  pool = special.length && (!general.length || Math.random() < 0.5) ? special : general;
  if (!pool.length) return null;
  let r = Math.random() * pool.reduce((a, it) => a + Number(it.drop_weight), 0);
  for (const it of pool) { r -= Number(it.drop_weight); if (r < 0) return it; }
  return pool[pool.length - 1];
}

/** grant(), but an organic drop is refused once the user had `cap` of them in 24h. One statement,
 *  so two drops landing at once can't both slip under the cap. */
async function grantCapped(userId, itemId, source, idem, cap) {
  await ready;
  const it = BY_ID[itemId];
  if (!it) return { ok: false, error: "unknown item" };
  if (!idem) return { ok: false, error: "idem required" };
  idem = String(idem).slice(0, 200);
  const ins = await runQuery(
    `INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, source, acquired, idem, locked)
     SELECT ?, ?, ?, ?, ?, 0 WHERE (SELECT COUNT(*) FROM user_cosmetics WHERE user_id = ? AND idem LIKE 'odrop-%'
                                    AND source LIKE 'drop:%' AND acquired > ?) < ?`,
    [userId, it.id, String(source || "drop").slice(0, 30), Date.now(), idem, userId, Date.now() - DAY_MS, Math.max(0, Math.floor(cap))]);
  if (ins && ins.changes) return { ok: true, inv_id: ins.id, already: false };
  const prev = await getQuery("SELECT id FROM user_cosmetics WHERE idem = ?", [idem]);
  if (prev.length) return { ok: true, inv_id: prev[0].id, already: true };
  return { ok: false, error: "daily_cap" };
}

/** Roll a drop for a settled win decided here (the wheel). Returns {id, name, rarity} or null. */
async function rollDrop(userId, event, key, opts = {}) {
  try {
    if (!userId) return null;
    const cfg = await dropConfig();
    const chance = Math.max(0, Math.min(1, Number(cfg[event]) || 0));
    if (!(chance > 0) || Math.random() >= chance) return null;
    const it = pickDrop(event, opts.minRarity);
    if (!it) return null;
    const r = opts.organic
      ? await grantCapped(userId, it.id, `drop:${event}`, `odrop-${event}-${key}`, cfg.cap)
      : await grant(userId, it.id, `drop:${event}`, `drop-${event}-${key}`);
    if (!r.ok || r.already) return null;
    if (it.kind === "name_color") invalidateNames();
    return { id: it.id, name: it.name, rarity: it.rarity || null };
  } catch (e) {
    console.error("[cosmetics] drop:", e.message);
    return null;
  }
}

/** Free unlocks. {achievement} grants items unlocked by that achievement; {level} grants every
 *  level unlock at or below it. Idempotent per user+item (idem unlock:<item>:<user>). */
async function grantUnlocks(userId, { achievement, level } = {}) {
  if (!userId) return [];
  const got = [];
  try {
    for (const it of ITEMS) {
      const u = it.unlock || {};
      const hit = (achievement && u.achievement === achievement) || (level != null && u.level && Number(level) >= u.level);
      if (!hit) continue;
      const r = await grant(userId, it.id, u.achievement ? "achievement" : "level", `unlock:${it.id}:${userId}`);
      if (r.ok && !r.already) got.push(it.id);
    }
  } catch (e) {
    console.error("[cosmetics] grantUnlocks:", e.message);
  }
  return got;
}

/** Catch up on unlocks earned before cosmetics existed (or via a quiet backfill). */
async function syncUnlocks(userId) {
  if (!userId) return [];
  const badges = await getQuery("SELECT badgeId FROM user_badges WHERE userId = ?", [userId]).catch(() => []);
  const lv = await getQuery("SELECT level FROM users WHERE userId = ?", [userId]).catch(() => []);
  const owned = new Set(badges.map((b) => b.badgeId));
  const got = [];
  for (const it of ITEMS) {
    const u = it.unlock || {};
    if (u.achievement && owned.has(u.achievement)) got.push(...await grantUnlocks(userId, { achievement: u.achievement }));
  }
  if (lv.length) got.push(...await grantUnlocks(userId, { level: Number(lv[0].level) || 0 }));
  return [...new Set(got)];
}

/** 1.99ax: quiet catch-up of level-unlock cosmetics for everyone already at or past their level (the
 *  level milestones every 5 levels added new ones). Runs once per set of level items - adding one
 *  runs it again - and grant() is idempotent per user + item, so a re-run only adds what's missing.
 *  Nothing is taken away and no PAT is paid. Returns {users, granted}. */
async function backfillLevelUnlocks({ force } = {}) {
  await ready;
  const lvItems = ITEMS.filter((it) => it.unlock && it.unlock.level);
  if (!lvItems.length) return { users: 0, granted: 0 };
  const sig = require("crypto").createHash("sha1")
    .update(lvItems.map((it) => `${it.id}@${it.unlock.level}`).sort().join(",")).digest("hex").slice(0, 16);
  await runQuery("CREATE TABLE IF NOT EXISTS cosmetic_meta (k TEXT PRIMARY KEY, v TEXT)");
  const done = await getQuery("SELECT v FROM cosmetic_meta WHERE k = 'level_backfill'");
  if (!force && done.length && done[0].v === sig) return { users: 0, granted: 0, skipped: true };
  const minLv = Math.min(...lvItems.map((it) => it.unlock.level));
  const users = await getQuery("SELECT userId, level FROM users WHERE level >= ?", [minLv]);
  let granted = 0;
  for (const u of users) granted += (await grantUnlocks(u.userId, { level: Number(u.level) || 0 })).length;
  await runQuery("INSERT INTO cosmetic_meta (k, v) VALUES ('level_backfill', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [sig]);
  console.log(`[cosmetics] level backfill: ${granted} item(s) for ${users.length} user(s) at Lv ${minLv}+`);
  return { users: users.length, granted };
}
setTimeout(() => backfillLevelUnlocks().catch((e) => console.error("[cosmetics] level backfill:", e.message)), 15000).unref();

/** Equip (on) or unequip one copy. */
async function equip(userId, invId, on) {
  await ready;
  const c = (await getQuery("SELECT id, item_id, locked FROM user_cosmetics WHERE id = ? AND user_id = ?", [invId, userId]))[0];
  if (!c || !BY_ID[c.item_id]) return { ok: false, error: "You don't own that item." };
  const kind = BY_ID[c.item_id].kind;
  if (on) {
    if (c.locked) return { ok: false, error: "That copy is listed on the market — cancel the listing first." };
    if (!perkLive(BY_ID[c.item_id], userId)) return { ok: false, error: "That one comes with a 🎟️ Season Pass - it's off until the pass is back (publicaccess.tv/premium)." };
    await runQuery(`INSERT INTO user_cosmetic_equips (user_id, kind, inv_id) VALUES (?, ?, ?)
                    ON CONFLICT(user_id, kind) DO UPDATE SET inv_id = excluded.inv_id`, [userId, kind, c.id]);
  } else {
    await runQuery("DELETE FROM user_cosmetic_equips WHERE user_id = ? AND kind = ? AND inv_id = ?", [userId, kind, c.id]);
  }
  if (kind === "name_color") invalidateNames();
  return { ok: true, kind, item_id: c.item_id, on: !!on };
}

/** Move a copy between users. With listingId, the listing must be active, for this copy and this
 *  seller; it's marked sold to the receiver. Idempotent by idem. */
async function transfer({ invId, fromId, toId, idem, listingId }) {
  await ready;
  if (!idem) return { ok: false, error: "idem required" };
  if (!invId || !fromId || !toId) return { ok: false, error: "inv_id, from and to required" };
  if (fromId === toId) return { ok: false, error: "can't transfer to the same user" };
  {
    const c0 = (await getQuery("SELECT item_id FROM user_cosmetics WHERE id = ?", [invId]))[0];
    if (c0 && isPerk(BY_ID[c0.item_id])) return { ok: false, error: "Season Pass items can't be traded or gifted" };
  }
  idem = String(idem).slice(0, 200);
  const claim = await runQuery("INSERT OR IGNORE INTO cosmetic_transfers (idem, inv_id, from_id, to_id, listing_id, created) VALUES (?, ?, ?, ?, ?, ?)",
    [idem, invId, fromId, toId, listingId || null, Date.now()]);
  if (!claim || !claim.changes) {
    const prev = (await getQuery("SELECT inv_id, to_id FROM cosmetic_transfers WHERE idem = ?", [idem]))[0];
    return { ok: true, already: true, inv_id: prev ? prev.inv_id : invId };
  }
  const undo = () => runQuery("DELETE FROM cosmetic_transfers WHERE idem = ?", [idem]).catch(() => {});
  try {
    const now = Date.now();
    if (listingId) {
      const l = await runQuery(`UPDATE cosmetic_listings SET status = 'sold', buyer_id = ?, updated = ?
                                WHERE id = ? AND status = 'active' AND inv_id = ? AND seller_id = ?`,
        [toId, now, listingId, invId, fromId]);
      if (!l || !l.changes) { await undo(); return { ok: false, error: "listing is not active" }; }
    }
    const mv = await runQuery(
      `UPDATE user_cosmetics SET user_id = ?, locked = 0, acquired = ?, source = ? WHERE id = ? AND user_id = ? ${listingId ? "" : "AND locked = 0"}`,
      [toId, now, listingId ? "market" : "gift", invId, fromId]);
    if (!mv || !mv.changes) {
      if (listingId) await runQuery("UPDATE cosmetic_listings SET status = 'active', buyer_id = NULL, updated = ? WHERE id = ?", [now, listingId]);
      await undo();
      return { ok: false, error: listingId ? "seller no longer owns that copy" : "not owned by sender (or it's listed)" };
    }
    await runQuery("DELETE FROM user_cosmetic_equips WHERE inv_id = ?", [invId]);
    await runQuery("UPDATE cosmetic_listings SET status = 'cancelled', updated = ? WHERE inv_id = ? AND status = 'active'", [now, invId]);
    invalidateNames();
    return { ok: true, inv_id: invId };
  } catch (e) {
    await undo();
    throw e;
  }
}

async function listingView(id) {
  await ready;
  const l = (await getQuery(
    `SELECT l.*, c.item_id, c.user_id AS owner_id, s.username AS seller_username, s.camfrogUsername AS seller_camfrog
     FROM cosmetic_listings l JOIN user_cosmetics c ON c.id = l.inv_id LEFT JOIN users s ON s.userId = l.seller_id
     WHERE l.id = ?`, [id]))[0];
  return l || null;
}

async function marketListings(sort) {
  await ready;
  const order = sort === "price" ? "l.price ASC, l.id DESC" : sort === "price_desc" ? "l.price DESC, l.id DESC" : "l.id DESC";
  const rows = await getQuery(
    `SELECT l.id, l.inv_id, l.price, l.created, l.seller_id, c.item_id, s.username AS seller, s.displayname AS seller_display,
            s.camfrogUsername AS seller_camfrog
     FROM cosmetic_listings l JOIN user_cosmetics c ON c.id = l.inv_id AND c.user_id = l.seller_id
     LEFT JOIN users s ON s.userId = l.seller_id
     WHERE l.status = 'active' ORDER BY ${order} LIMIT 300`);
  return rows.filter((r) => BY_ID[r.item_id]).map((r) => ({ ...r, item: BY_ID[r.item_id], r: render(BY_ID[r.item_id]) }));
}

async function showcaseFor(userId) {
  await ready;
  const row = (await getQuery("SELECT badges FROM user_badge_showcase WHERE user_id = ?", [userId]))[0];
  let ids = [];
  try { ids = JSON.parse((row && row.badges) || "[]"); } catch (e) { ids = []; }
  ids = (Array.isArray(ids) ? ids : []).slice(0, SHOWCASE_MAX).map(String);
  if (!ids.length) return [];
  const rows = await getQuery(
    `SELECT b.badgeId, b.name, b.description, b.icon FROM badges b JOIN user_badges ub ON ub.badgeId = b.badgeId AND ub.userId = ?
     WHERE b.badgeId IN (${ids.map(() => "?").join(",")})`, [userId, ...ids]);
  const by = Object.fromEntries(rows.map((r) => [r.badgeId, r]));
  return ids.map((i) => by[i]).filter(Boolean);
}

async function seedFor(camfrog) {
  if (!camfrog) return null;
  await ready;
  const r = await getQuery("SELECT seed FROM cosmetic_avatar_seeds WHERE camfrog = LOWER(?)", [String(camfrog)]);
  return r.length && r[0].seed ? Number(r[0].seed) : null;
}

/** Everything the profile page needs for one user (by exact PATV username). */
async function profileData(username) {
  const u = (await getQuery("SELECT userId, camfrogUsername FROM users WHERE username = ?", [username]))[0];
  if (!u) return null;
  const eq = await equippedFor(u.userId);
  const gtf = {};
  for (const k of GTF_KINDS) if (eq[k]) gtf[GTF_OPT[k]] = eq[k].r.layer;
  return { equipped: eq, showcase: await showcaseFor(u.userId), seed: await seedFor(u.camfrogUsername), gtf, seasonPass: passOn(u.userId) };   // 1.99iv: + the 🎟️ chip
}

// ── helpers for routes ──
const intOf = (v) => { const n = parseInt(String(v == null ? "" : v).replace(/[, _]/g, ""), 10); return Number.isFinite(n) ? n : 0; };
const parsePrice = (v) => {
  const m = String(v == null ? "" : v).trim().toLowerCase().replace(/[, _]/g, "").match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  if (!m) return 0;
  return Math.floor(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1));
};
const cleanName = (s) => String(s == null ? "" : s).trim().replace(/^@/, "").replace(/[\r\n\t ]+/g, "").slice(0, 60);
function sameSite(req) {
  // The login cookie is SameSite=Lax, so cross-site POSTs arrive signed out anyway; this is a second
  // check for browsers that send Origin/Referer.
  const host = req.get("host");
  const src = req.get("origin") || req.get("referer");
  if (!src || !host) return true;
  try { return new URL(src).host === host; } catch (e) { return false; }
}

/** Data the /cosmetics page renders. */
async function pageData(req) {
  const now = Date.now();
  const tab = ["shop", "market", "mine", "showcase", "how"].includes(String(req.query.tab)) ? String(req.query.tab) : "shop";
  const sort = ["price", "price_desc", "newest"].includes(String(req.query.sort)) ? String(req.query.sort) : "newest";
  const byKind = {};
  for (const k of KINDS) byKind[k] = [];
  for (const it of ITEMS) {
    if (!byKind[it.kind]) continue;
    byKind[it.kind].push({ ...it, r: render(it), sale: onSale(it, now), seasonState: seasonState(it, now),
      seasonEnd: it.season ? dayMs(it.season.to) : null, seasonStart: it.season ? dayMs(it.season.from) : null });
  }
  const seasons = {};
  for (const it of ITEMS) {
    if (!it.season) continue;
    const st = seasonState(it, now);
    if (st === "over") continue;
    const key = it.season.label || `${it.season.from}..${it.season.to}`;
    if (!seasons[key]) seasons[key] = { label: key, state: st, from: dayMs(it.season.from), to: dayMs(it.season.to), items: [] };
    seasons[key].items.push({ ...it, r: render(it), sale: onSale(it, now) });
  }
  const d = {
    now, tab, sort, kinds: CAT.kinds || {}, rarities: CAT.rarities || {}, tags: TAGS, byKind, seasonStateOf: seasonState, dayMs, seasons: Object.values(seasons).sort((a, b) => a.from - b.from),
    listings: await marketListings(sort), fee: MARKET_FEE_PCT, listMin: LIST_MIN, showcaseMax: SHOWCASE_MAX,
    user: req.user ? req.user.username : null, me: null, inv: null, badges: [], showcase: [], acts: [], seed: null,
    msg: req.query.msg ? String(req.query.msg).slice(0, 200) : null, ACCOUNT_KINDS, GTF_KINDS, counts: {},
    myListings: new Set(), equippedR: {}, achName: ACH_NAME,
    padCat: [],                                  // 1.99ew: premium PAD cosmetics (padcosmetics.js) - the "Pad" group
  };
  try { d.padCat = require("./padcosmetics").catalog(now).filter((i) => i.sale); } catch (e) { d.padCat = []; }
  for (const it of ITEMS) d.counts[it.kind] = (d.counts[it.kind] || 0) + 1;
  if (req.user && req.user.userId) {
    const me = await resolveUser({ userId: req.user.userId });
    if (me) {
      await syncUnlocks(me.userId).catch((e) => console.error("[cosmetics] sync:", e.message));
      d.me = { userId: me.userId, username: me.username, display: me.displayname || me.username, camfrog: me.camfrogUsername || null,
               balance: Number(me.points_balance) || 0, level: Number(me.level) || 0, avatar: me.avatar || "/public/img/avatar.png" };
      const inv = await inventory(me.userId);
      const groups = {};
      for (const i of inv.items) (groups[i.kind] = groups[i.kind] || []).push({ ...i, item: BY_ID[i.item_id], r: render(BY_ID[i.item_id]) });
      d.inv = { groups, count: inv.items.length, equipped: inv.equipped };
      d.equippedR = {};
      for (const [k, id] of Object.entries(inv.equipped)) d.equippedR[k] = render(BY_ID[id]);
      d.badges = await getQuery(`SELECT b.badgeId, b.name, b.description, b.icon FROM badges b JOIN user_badges ub ON ub.badgeId = b.badgeId
                                 WHERE ub.userId = ? ORDER BY b.name`, [me.userId]);
      d.showcase = (await showcaseFor(me.userId)).map((b) => b.badgeId);
      d.acts = await require("./actions").recentFor(me.userId, "cosmetics");
      d.seed = await seedFor(me.camfrogUsername);
      d.myListings = new Set(d.listings.filter((l) => l.seller_id === me.userId).map((l) => l.id));
    }
  }
  return d;
}

function register(app, { isBotToken, addUser }) {
  const bot = (handler) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      await ready;
      await handler(b, res);
    } catch (e) {
      console.error("[cosmetics] api:", e);
      res.status(500).json({ ok: false, error: "server error" });
    }
  };

  // ── public ──
  app.get("/api/cosmetics/catalog", (req, res) => {
    const now = Date.now();
    res.set("Cache-Control", "public, max-age=300");
    res.json({ rarities: CAT.rarities, kinds: CAT.kinds, tags: TAGS, market_fee_pct: MARKET_FEE_PCT, list_min: LIST_MIN,
               items: ITEMS.map((i) => ({ ...i, on_sale: onSale(i, now), season_state: seasonState(i, now) })) });
  });

  app.get("/api/cosmetics/equipped/:camfrog", async (req, res) => {
    try {
      const u = await resolveUser({ camfrog: req.params.camfrog });
      const out = {};
      if (u) {
        const eq = await equippedFor(u.userId);
        for (const k of GTF_KINDS) if (eq[k]) out[k] = { item_id: eq[k].item_id, style: eq[k].item.style };
      }
      res.set("Cache-Control", "public, max-age=60");
      res.set("Access-Control-Allow-Origin", "*");          // heist sheet pages fetch it in the browser
      res.json(out);
    } catch (e) {
      console.error("[cosmetics] equipped:", e);
      res.set("Access-Control-Allow-Origin", "*");
      res.status(500).json({});
    }
  });

  // ── bot ──
  app.post("/api/cosmetics/grant", bot(async (b, res) => {
    const u = await resolveUser(b.user);
    if (!u) return res.status(404).json({ ok: false, error: "no such user" });
    const cap = Number(b.cap);
    const r = (Number.isFinite(cap) && cap >= 0 && String(b.idem || "").startsWith("odrop-"))
      ? await grantCapped(u.userId, String(b.item || ""), b.source || "drop", b.idem, cap)
      : await grant(u.userId, String(b.item || ""), b.source || "drop", b.idem);
    if (r.ok && !r.already && BY_ID[b.item] && BY_ID[b.item].kind === "name_color") invalidateNames();
    res.status(r.ok ? 200 : 400).json({ ...r, username: u.username, camfrog: u.camfrogUsername || null });
  }));

  app.post("/api/cosmetics/drop-config", bot(async (b, res) => {
    await setDropConfig(b.rates, b.cap);
    res.json({ ok: true, config: await dropConfig() });
  }));

  app.post("/api/cosmetics/transfer", bot(async (b, res) => {
    const from = await resolveUser(b.from), to = await resolveUser(b.to);
    if (!from || !to) return res.status(404).json({ ok: false, error: !from ? "no such sender" : "no such recipient" });
    const r = await transfer({ invId: intOf(b.inv_id), fromId: from.userId, toId: to.userId, idem: b.idem,
                               listingId: b.listing_id ? intOf(b.listing_id) : null });
    res.status(r.ok ? 200 : 409).json(r);
  }));

  app.post("/api/cosmetics/listing", bot(async (b, res) => {
    const l = await listingView(intOf(b.id));
    if (!l) return res.status(404).json({ ok: false, error: "no such listing" });
    res.json({ ok: true,
      listing: { id: l.id, inv_id: l.inv_id, price: l.price, status: l.status, created: l.created, updated: l.updated, buyer_id: l.buyer_id || null,
                 valid: l.status === "active" && l.owner_id === l.seller_id },
      item: BY_ID[l.item_id] || { id: l.item_id },
      seller: { username: l.seller_username || null, camfrog: l.seller_camfrog || null },
      fee_pct: MARKET_FEE_PCT });
  }));

  app.post("/api/cosmetics/inventory", bot(async (b, res) => {
    const u = await resolveUser(b.user);
    if (!u) return res.status(404).json({ ok: false, error: "no such user" });
    await syncUnlocks(u.userId);
    const inv = await inventory(u.userId);
    res.json({ ok: true, username: u.username, camfrog: u.camfrogUsername || null,
               items: inv.items.map((i) => ({ inv_id: i.inv_id, item_id: i.item_id, kind: i.kind, name: i.name, rarity: i.rarity,
                                              locked: i.locked, equipped: i.equipped, listing_id: i.listing_id })),
               equipped: inv.equipped });
  }));

  app.post("/api/cosmetics/equip", bot(async (b, res) => {
    const u = await resolveUser(b.user);
    if (!u) return res.status(404).json({ ok: false, error: "no such user" });
    const on = !(b.on === false || b.on === "false" || b.on === 0 || b.on === "0");
    let invId = intOf(b.inv_id);
    if (!invId && b.item_id) {
      const it = BY_ID[String(b.item_id)];
      if (!it) return res.status(400).json({ ok: false, error: "unknown item" });
      const inv = await inventory(u.userId);
      const copies = inv.items.filter((i) => i.item_id === it.id);
      const pick = on ? copies.find((i) => !i.locked) : copies.find((i) => i.equipped);
      if (!pick) return res.status(404).json({ ok: false, error: on ? (copies.length ? "every copy is listed on the market" : "you don't own that") : "not equipped" });
      invId = pick.inv_id;
    }
    if (!invId && !on && b.kind) {                      // unequip a whole slot (ok even if it was empty)
      if (!KINDS.includes(String(b.kind))) return res.status(400).json({ ok: false, error: "unknown kind" });
      await runQuery("DELETE FROM user_cosmetic_equips WHERE user_id = ? AND kind = ?", [u.userId, String(b.kind)]);
      if (b.kind === "name_color") invalidateNames();
      return res.json({ ok: true, kind: String(b.kind), on: false });
    }
    if (!invId) return res.status(400).json({ ok: false, error: "item_id, inv_id or kind required" });
    const r = await equip(u.userId, invId, on);
    res.status(r.ok ? 200 : 400).json(r);
  }));

  app.post("/api/cosmetics/seed", bot(async (b, res) => {
    const camfrog = String(b.camfrog || "").trim().toLowerCase().slice(0, 60);
    const seed = intOf(b.seed);
    if (!camfrog || !seed) return res.status(400).json({ ok: false, error: "camfrog and seed required" });
    await runQuery(`INSERT INTO cosmetic_avatar_seeds (camfrog, seed, updated) VALUES (?, ?, ?)
                    ON CONFLICT(camfrog) DO UPDATE SET seed = excluded.seed, updated = excluded.updated`, [camfrog, seed, Date.now()]);
    res.json({ ok: true });
  }));

  // ── pages ──
  app.get("/cosmetics", addUser, async (req, res) => {
    try {
      const d = await pageData(req);
      res.locals.og = require("./og").forPage(req, "PATV Cosmetics", "Name colors, profile banners, borders, effects and Grand Theft Frogger avatar gear. Buy, earn, trade.");
      res.render("cosmetics", d);
    } catch (e) {
      console.error("[cosmetics] page:", e);
      res.status(500).send("Couldn't load cosmetics.");
    }
  });

  // Owner actions done on the site (no PAT involved)
  const owner = (fn) => async (req, res) => {
    const tab = String((req.body || {}).tab || "mine").replace(/[^a-z]/g, "") || "mine";
    const back = (msg) => res.redirect(`/cosmetics?tab=${tab}&msg=${encodeURIComponent(msg)}#tabs`);
    if (!req.user || !req.user.userId) return res.redirect("/login");
    if (!sameSite(req)) return res.status(403).send("Forbidden");
    try {
      await ready;
      await fn(req.body || {}, req.user.userId, back);
    } catch (e) {
      console.error("[cosmetics] owner action:", e);
      back("Something went wrong — nothing changed.");
    }
  };

  app.post("/cosmetics/equip", addUser, owner(async (b, me, back) => {
    const on = String(b.on) !== "0";
    const r = await equip(me, intOf(b.inv_id), on);
    if (!r.ok) return back(r.error);
    back(on ? `Equipped ${BY_ID[r.item_id].name}.` : `Unequipped ${BY_ID[r.item_id].name}.`);
  }));

  app.post("/cosmetics/list", addUser, owner(async (b, me, back) => {
    const invId = intOf(b.inv_id);
    const price = parsePrice(b.price);
    if (price < LIST_MIN) return back(`List it for at least ${LIST_MIN.toLocaleString("en-US")} PAT.`);
    if (price > LIST_MAX) return back("That price is too high.");
    const c = (await getQuery("SELECT id, item_id, locked FROM user_cosmetics WHERE id = ? AND user_id = ?", [invId, me]))[0];
    if (!c || !BY_ID[c.item_id]) return back("You don't own that item.");
    if (isPerk(BY_ID[c.item_id])) return back("Season Pass items can't be sold.");
    if (c.locked) return back("That copy is already listed.");
    const open = await getQuery("SELECT COUNT(*) AS n FROM cosmetic_listings WHERE seller_id = ? AND status = 'active'", [me]);
    if (open[0].n >= MAX_LISTINGS) return back(`You can have ${MAX_LISTINGS} listings at a time.`);
    const lock = await runQuery("UPDATE user_cosmetics SET locked = 1 WHERE id = ? AND user_id = ? AND locked = 0", [invId, me]);
    if (!lock || !lock.changes) return back("That copy is already listed.");
    await runQuery("DELETE FROM user_cosmetic_equips WHERE user_id = ? AND inv_id = ?", [me, invId]);
    const now = Date.now();
    const l = await runQuery("INSERT INTO cosmetic_listings (inv_id, seller_id, price, status, created, updated) VALUES (?, ?, ?, 'active', ?, ?)",
      [invId, me, price, now, now]);
    if (BY_ID[c.item_id].kind === "name_color") invalidateNames();
    back(`Listed ${BY_ID[c.item_id].name} for ${price.toLocaleString("en-US")} PAT (listing #${l.id}).`);
  }));

  app.post("/cosmetics/cancel", addUser, owner(async (b, me, back) => {
    const id = intOf(b.listing_id);
    const l = (await getQuery("SELECT inv_id FROM cosmetic_listings WHERE id = ? AND seller_id = ? AND status = 'active'", [id, me]))[0];
    if (!l) return back("That listing isn't active.");
    const r = await runQuery("UPDATE cosmetic_listings SET status = 'cancelled', updated = ? WHERE id = ? AND seller_id = ? AND status = 'active'", [Date.now(), id, me]);
    if (!r || !r.changes) return back("That listing isn't active.");
    await runQuery("UPDATE user_cosmetics SET locked = 0 WHERE id = ? AND user_id = ?", [l.inv_id, me]);
    back(`Listing #${id} cancelled — the item is back in your inventory.`);
  }));

  app.post("/cosmetics/gift", addUser, owner(async (b, me, back) => {
    const invId = intOf(b.inv_id);
    const to = await resolveUser(cleanName(b.to));
    if (!to) return back("Couldn't find that user (use their PATV username or Camfrog name).");
    if (to.userId === me) return back("You already own it.");
    const c = (await getQuery("SELECT item_id, locked FROM user_cosmetics WHERE id = ? AND user_id = ?", [invId, me]))[0];
    if (!c || !BY_ID[c.item_id]) return back("You don't own that item.");
    if (c.locked) return back("Cancel the listing before gifting it.");
    const r = await transfer({ invId, fromId: me, toId: to.userId, idem: `gift:${invId}:${me}:${Date.now()}` });
    if (!r.ok) return back("Couldn't gift it — " + r.error);
    back(`Gifted ${BY_ID[c.item_id].name} to ${to.displayname || to.username}.`);
  }));

  app.post("/cosmetics/showcase", addUser, owner(async (b, me, back) => {
    const want = [...new Set([].concat(b.badges || []).map((x) => String(x).slice(0, 80)))].slice(0, SHOWCASE_MAX + 1);
    if (want.length > SHOWCASE_MAX) return back(`Pick up to ${SHOWCASE_MAX} badges.`);
    let ids = [];
    if (want.length) {
      const own = await getQuery(`SELECT badgeId FROM user_badges WHERE userId = ? AND badgeId IN (${want.map(() => "?").join(",")})`, [me, ...want]);
      const ok = new Set(own.map((r) => r.badgeId));
      ids = want.filter((w) => ok.has(w));
    }
    await runQuery(`INSERT INTO user_badge_showcase (user_id, badges) VALUES (?, ?)
                    ON CONFLICT(user_id) DO UPDATE SET badges = excluded.badges`, [me, JSON.stringify(ids)]);
    back(ids.length ? `Showcase saved (${ids.length} badge${ids.length === 1 ? "" : "s"}).` : "Showcase cleared.");
  }));

  // Things that cost PAT: queued for Pepe, who runs `!cosmetic ...` as the user and charges them.
  app.post("/cosmetics/act", addUser, async (req, res) => {
    const b = req.body || {};
    const tab = String(b.tab || "shop").replace(/[^a-z]/g, "") || "shop";
    const back = (msg) => res.redirect(`/cosmetics?tab=${tab}&msg=${encodeURIComponent(msg)}#tabs`);
    if (!req.user || !req.user.userId) return res.redirect("/login");
    if (!sameSite(req)) return res.status(403).send("Forbidden");
    try {
      const me = await resolveUser({ userId: req.user.userId });
      if (!me) return back("Couldn't find your account.");
      if (!me.camfrogUsername) return back("Link your Camfrog name first — Pepe runs this as you.");
      const op = String(b.op || "");
      let args;
      if (op === "buy" || op === "gift") {
        const it = BY_ID[String(b.item || "")];
        if (!it) return back("That item doesn't exist.");
        if (!onSale(it)) return back(`${it.name} isn't for sale right now.`);
        if (Number(me.points_balance) < it.price) return back(`${it.name} costs ${it.price.toLocaleString("en-US")} PAT — you have ${Number(me.points_balance).toLocaleString("en-US")}.`);
        if (op === "buy") {
          args = ["cosmetic", "buy", it.id];
        } else {
          const to = await resolveUser(cleanName(b.to));
          if (!to) return back("Couldn't find who you're gifting to.");
          if (!to.camfrogUsername) return back(`${to.username} hasn't linked a Camfrog name, so Pepe can't deliver it.`);
          if (to.userId === me.userId) return back("That's you — use Buy instead.");
          args = ["cosmetic", "gift", it.id, "@" + to.camfrogUsername];
        }
      } else if (op === "buylisting") {
        const l = await listingView(intOf(b.listing));
        if (!l || l.status !== "active") return back("That listing is gone.");
        if (l.seller_id === me.userId) return back("That's your own listing — cancel it in My items.");
        if (Number(me.points_balance) < l.price) return back(`That costs ${Number(l.price).toLocaleString("en-US")} PAT — you have ${Number(me.points_balance).toLocaleString("en-US")}.`);
        args = ["cosmetic", "buylisting", String(l.id)];
      } else {
        return back("That can't be done from the site.");
      }
      await require("./actions").queue(me.userId, { kind: "cmd", args, tag: "cosmetics", label: "!" + args.join(" ") });
      back("Sent to Pepe — the result shows below in a few seconds.");
    } catch (e) {
      back(e.message === "busy" ? "You already have a few things waiting — give Pepe a moment." : "Something went wrong — nothing was sent.");
    }
  });
}

/** Middleware: res.locals.cosmeticName(username) -> css for that user's name color, and
 *  res.locals.cosmeticNameHtml(username, display). Also preloads the profile page's cosmetics.
 *  Call before the routes that should get them. */
function locals(app) {
  app.use(async (req, res, next) => {
    res.locals.cosmeticName = nameStyle;
    res.locals.cosmeticNameHtml = nameHtml;
    if (!nameAt) await refreshNames();          // first request after boot
    next();
  });
  app.get(["/u/:username", "/u/:username/:tab(posts|overview|analytics)"], async (req, res, next) => {     // 1.99dv: the profile + its tabs
    try {
      res.locals.profileCosmetics = await profileData(req.params.username);
    } catch (e) {
      console.error("[cosmetics] profile:", e.message);
      res.locals.profileCosmetics = null;
    }
    next();
  });
}

/** 1.99iv: put the Season Pass perk items in this account's inventory (idempotent; premium.js calls it). */
async function grantSeasonPerks(userId) {
  let n = 0;
  for (const id of PERK_IDS) { const r = await grant(userId, id, "season_pass", `sp-perk:${userId}:${id}`); if (r.ok && !r.already) n++; }
  invalidateNames();
  return n;
}

module.exports = {
  grantSeasonPerks, isPerk, invalidateNames: () => invalidateNames(), PERK_IDS,
  register, locals, grantUnlocks, syncUnlocks, backfillLevelUnlocks, nameStyles, nameStyle, nameHtml, render, onSale, seasonState,
  resolveUser, grant, grantCapped, rollDrop, pickDrop, dropConfig, setDropConfig, transfer, equip, inventory, equippedFor, profileData, pageData,
  catalog: () => ITEMS, byId: (id) => BY_ID[id] || null, ready, MARKET_FEE_PCT, LIST_MIN,
};
