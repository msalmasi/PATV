// staleaccounts.js - 1.99bm: stale and junk accounts are ARCHIVED, never deleted with money in them.
//
// Why: most PATV accounts are Pepe's automatic "CFxxxxxxxx" accounts, made the first time a Camfrog
// login earned XP or was looked up. Many never did anything themselves, yet hold level-up / raffle /
// mic-hour PAT. Before a token snapshot that PAT would be supply nobody can ever claim.
//
// Tiers (classify()):
//   A  auto "CF" account, zero activity of its own (only passive mints: level-ups, raffles, mic hours,
//      achievements, welcome), no tips either way, no purchases, nothing earned beyond the automatic
//      badges / level cosmetics, no Discord/Twitch, unseen for tierADays (default 90)
//   B  auto "CF" account with a handful of actions (<= lowMax, default 3, on <= lowDays distinct days)
//      and otherwise like A, unseen for dormantDays (default 180)
//   C  web account with no Camfrog/Discord/Twitch link, an unverified or junk email (no "@", disposable
//      domain, empty), <= lowMax actions and nothing earned, unseen for dormantDays
//   G  ownerless ghost: an auto account with no Camfrog login, or whose "login" is another PATV account's
//      "CFxxxxxxxx" name (made before 1.99az), with no own activity - reclaimed regardless of age
//   A2 made by the Twitch/Discord bot (placeholder email), no own activity, dormant - NOT selected by
//      default: the person can still sign in with Twitch/Discord, which restores it
//   M  duplicate: a second account on the same Camfrog login (or one of Pepe's aliases of it) - MERGED
//      into the primary (the real account, else the oldest) with mergeDuplicate(), never reclaimed
//   D  dormant (unseen for dormantDays) but real: has history, tips, purchases, a linked identity or
//      earned items. KEPT - candidates for the "claim your balance" notice
//   X  excluded, never touched: admins/staff/role holders, Pepe's own logins, room owners, anyone with
//      PAT in flight (loans either side, escrow holds, stage slots, open market positions or web
//      orders, bounties, wagers, lotto tickets, stashes/vault shares, gang membership, open shop
//      orders or cosmetic listings, pending Camfrog link), a pending welcome bonus inside its window,
//      or a negative balance
//   active  seen recently
//
// Archiving (archive()): one transaction per account. The whole-PAT part of the balance goes back to
// the Federal Reserve - a "stale-reclaim" transaction on the account (history stays intact) and a
// NEGATIVE reserve_claims row, flow "stale_reclaim", which Pepe's funding tick credits to the Reserve
// (the same path as shop fees / stage revenue). users.archived_at is set: archived accounts are hidden
// from leaderboards and member counts. An account_archive row records what was taken, by which run.
//
// Restoring (restore()): signing in, a Discord/Twitch sign-in, Pepe looking the Camfrog login up (the
// person is back in a room), or linking the Camfrog name gives everything back - "stale-restore"
// transaction + a positive reserve_claims row (flow "stale_restore", Pepe drains the Reserve). Until
// purge, nothing is lost.
//
// Purging (purge()): tier A only, after graceDays (default 60) and only if still archived, still
// empty and still free of holds: the users row and its non-ledger rows (badges, cosmetics, inbox,
// welcome rows...) go; the ledger (transactions, bonus_winners, spins, rakes, reserve_claims...) stays
// for audit, with a snapshot of the account in account_archive.
//
// Nothing here runs by itself. migrate-stale-accounts.js is the operator's tool (dry run by default).
"use strict";
const { v4: uuidv4 } = require("uuid");
const { runQuery, getQuery } = require("./dbUtils");

const DAY = 86400000;
const CF_RANDOM = /^CF[a-z0-9]{8}$/;
const CF_RANDOM_LOGIN = /^cf[a-z0-9]{8}$/;
const DEFAULTS = { tierADays: 90, dormantDays: 180, lowMax: 3, lowDays: 2, graceDays: 60, welcomeDays: 90 };

// Badges every account gets without doing anything.
const AUTO_BADGES = new Set(["fresh_meat", "twitch-user", "discord-user", "cf_linked"]);
// Pepe's own Camfrog logins (and the staging bot) - never classified.
const SYSTEM_LOGINS = new Set(["pepefrog", "pepebeta", "pepefrog.room", "pepebeta.room"]);

// Transaction types. "bonus win" rows take their real type from bonus_winners.
const SYSTEM_DEBIT = /^(fine|automod-fine|exploit|staff transfer|ledger-correction|bounty-refund-reversal|stale-reclaim|clawback|account merge|zero)/i;
const ACTIVE_CREDIT = /^(beg|pictionary-win|camfrog-trivia|trivia-payout|store sale|market-sell|market-win|duel winnings|holdem-cashout|bounty-win|showdown-win|arena-win|brawl-win)/i;
// passive credits that still mean "was in a room / on the site" (raffles need chat, mic hours need the
// mic, level-ups need XP)
const PRESENCE_CREDIT = /(raffle|mic-hourly|moan-bonus|level|achievement|channelpoints|connect|welcome)/i;
const TIP = /^tip (sent|received)$/i;
const PURCHASE = /^(purchase of |cosmetic-buy|market-buy|market-stake|sponsor|stage slot hold)/i;
const RESTORE_GUARD = /^stale-(reclaim|restore)$/i;

const MAJOR_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "icloud.com",
  "me.com", "aol.com", "protonmail.com", "proton.me", "msn.com", "ymail.com", "hotmail.co.uk", "yahoo.co.uk", "mail.com",
  "gmx.com", "comcast.net", "att.net", "verizon.net"]);
const DISPOSABLE_RE = /(temp|trash|mailinator|guerrilla|10minute|throwaway|yopmail|sharklasers|discard|fake|dispos|getnada|maildrop|mohmal|emailondeck|burner|1secmail|inboxkitten|spamgourmet|mailnesia|moakt)/i;

/** Email -> a category, never the address. */
function emailCategory(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return "empty";
  if (!e.includes("@")) return "no-at";
  const dom = e.split("@").pop();
  if (DISPOSABLE_RE.test(dom)) return "disposable";
  if (/(^|\.)(example\.(com|org|net)|test|invalid|localhost|local)$/.test(dom)) return "placeholder";
  if (MAJOR_MAIL.has(dom)) return "major";
  return "other";
}
const JUNK_EMAIL = new Set(["empty", "no-at", "disposable", "placeholder"]);

// SQLite "YYYY-MM-DD HH:MM:SS" (UTC) / epoch s / epoch ms -> ms
function ms(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v < 1e12 ? Math.round(v * 1000) : v;
  const s = String(v);
  if (/^\d+(\.\d+)?$/.test(s)) return ms(Number(s));
  const t = Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return isNaN(t) ? 0 : t;
}

async function tableExists(t) {
  return (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;
}
async function hasColumn(t, c) {
  const cols = await getQuery(`SELECT name FROM pragma_table_info(?)`, [t]).catch(() => []);
  return cols.some((x) => x.name === c);
}

let readyP = null, columnReady = false;
/** users.archived_at + the account_archive table. Idempotent; retried until the users table exists. */
function ensure() {
  if (readyP) return readyP;
  readyP = (async () => {
    if (!(await tableExists("users"))) { readyP = null; return false; }
    if (!(await hasColumn("users", "archived_at"))) {
      try { await runQuery("ALTER TABLE users ADD COLUMN archived_at INTEGER"); }
      catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
    }
    await runQuery(`CREATE TABLE IF NOT EXISTS account_archive (
      userId TEXT PRIMARY KEY, run_id TEXT, tier TEXT, reason TEXT, archived_at INTEGER NOT NULL,
      balance REAL, reclaimed INTEGER NOT NULL DEFAULT 0, reclaim_tx TEXT, reclaim_claim TEXT,
      restored_at INTEGER, restored_via TEXT, restore_tx TEXT, restore_claim TEXT,
      purge_after INTEGER, purged_at INTEGER, snapshot TEXT)`);
    await runQuery("CREATE INDEX IF NOT EXISTS account_archive_run ON account_archive (run_id)");
    columnReady = true;
    return true;
  })().catch((e) => { readyP = null; console.error("[stale] ensure:", e.message); return false; });
  return readyP;
}

// One transaction at a time on the shared connection (same pattern as mainstage.js).
let chain = Promise.resolve();
const sleep = (n) => new Promise((r) => setTimeout(r, n));
function tx(fn) {
  const run = chain.then(async () => {
    for (let i = 0; ; i++) {
      try { await runQuery("BEGIN IMMEDIATE TRANSACTION"); break; } catch (e) {
        if (i >= 60 || !/within a transaction|SQLITE_BUSY|locked/i.test(e.message)) throw e;
        await sleep(50);
      }
    }
    try { const out = await fn(); await runQuery("COMMIT"); return out; }
    catch (e) { try { await runQuery("ROLLBACK"); } catch (_) { /* none open */ } throw e; }
  });
  chain = run.catch(() => {});
  return run;
}

function safeJson(s, dflt) { try { return typeof s === "string" ? JSON.parse(s) : (s || dflt); } catch (e) { return dflt; } }
// every string inside an object, lowercased (logins / usernames of whoever is in it)
function strings(o, out = new Set(), depth = 0) {
  if (o == null || depth > 8) return out;
  if (typeof o === "string") { out.add(o.toLowerCase()); return out; }
  if (Array.isArray(o)) { for (const x of o) strings(x, out, depth + 1); return out; }
  if (typeof o === "object") for (const [k, v] of Object.entries(o)) { out.add(k.toLowerCase()); strings(v, out, depth + 1); }
  return out;
}
const OPEN = /^(open|active|pending|held|offered|accepted|running|live|late|waiting|placed|locked|requested|in_progress|disputed|fulfilled)$/i;

/**
 * Pepe's side (optional): parsed copies of his data files - {userstats, greeter, activity, loans, escrow,
 * pvaults, gangs, markets, bounties, wagers, lotto, shared}. Returns {seen: login -> ms, holds:
 * login|username -> [reasons], alias: login -> canonical}.
 */
function botFacts(bot) {
  const seen = new Map(), holds = new Map(), alias = new Map();
  const see = (l, t) => { l = String(l || "").toLowerCase(); t = ms(t); if (l && t > (seen.get(l) || 0)) seen.set(l, t); };
  const hold = (who, why) => { for (const w of [].concat(who)) { const l = String(w || "").toLowerCase(); if (!l) continue; if (!holds.has(l)) holds.set(l, new Set()); holds.get(l).add(why); } };
  if (!bot) return { seen, holds, alias };
  const us = (bot.userstats && bot.userstats.users) || {};
  for (const [l, d] of Object.entries(us)) { see(l, d && d.last); if (d && d.m) see(l, d.m.last); if (d && d.c) see(l, d.c.last); }
  for (const room of Object.values(bot.greeter || {})) if (room && typeof room === "object") for (const [l, t] of Object.entries(room)) see(l, t);
  for (const [l, rows] of Object.entries(bot.activity || {})) if (Array.isArray(rows)) for (const r of rows) if (Array.isArray(r)) see(l, Math.max(ms(r[0]), ms(r[3])));
  const vals = (o) => (Array.isArray(o) ? o : Object.values(o || {}));
  for (const ln of vals((bot.loans || {}).loans)) if (ln && OPEN.test(String(ln.status || ""))) hold([ln.lender, ln.borrower], "loan");
  for (const rq of vals((bot.loans || {}).requests)) if (rq && OPEN.test(String(rq.status || "open"))) hold(rq.nick, "loan request");
  for (const h of vals((bot.escrow || {}).holds)) if (h && h.state === "held") hold([h.nick, h.user], "escrow hold");
  for (const p of vals((bot.escrow || {}).payouts)) if (p && p.state !== "paid") hold([p.nick, p.user], "escrow payout");
  for (const v of vals((bot.pvaults || {}).vaults)) if (v && !v.closed && (Number(v.balance) > 0 || Number(v.staked) > 0)) hold([v.owner].concat(v.members || []), "stash");
  for (const l of Object.keys((bot.gangs || {}).members || {})) hold(l, "gang member");
  for (const m of vals((bot.markets || {}).markets)) if (m && OPEN.test(String(m.status || ""))) for (const s of strings(m.bets)) hold(s, "market position");
  for (const m of vals((bot.markets || {}).markets)) if (m && OPEN.test(String(m.status || ""))) hold([m.creator, m.judge], "market creator/judge");
  for (const b of vals((bot.bounties || {}).bounties)) if (b && OPEN.test(String(b.status || ""))) for (const s of strings({ c: b.creator, p: b.pot, h: b.hunters, k: b.claims })) hold(s, "bounty");
  for (const w of vals((bot.wagers || {}).wagers)) if (w && OPEN.test(String(w.status || ""))) hold([w.creator, w.opponent, w.judge], "wager");
  for (const t of vals((bot.lotto || {}).tickets)) if (t && !/^(paid|settled|lost|refunded|done)$/i.test(String(t.state || ""))) hold(t.who, "lotto ticket");
  for (const [a, c] of Object.entries((bot.shared || {}).alias_map || {})) alias.set(String(a).toLowerCase(), String(c).toLowerCase());
  return { seen, holds, alias };
}

/** Everything classify() needs, per account. */
async function gather({ now = Date.now(), bot = null, welcomeDays = DEFAULTS.welcomeDays } = {}) {
  // read-only: works on a database that has never had the archive column (dry runs write nothing)
  const arch = (await hasColumn("users", "archived_at")) ? "archived_at" : "NULL AS archived_at";
  const users = await getQuery(`SELECT userId, username, class, email, isEmailVerified, discordId, twitchId, camfrogUsername,
    points_balance, created_at, ${arch} FROM users`);
  const F = new Map();
  for (const u of users) {
    F.set(u.userId, {
      userId: u.userId, username: u.username, isCF: CF_RANDOM.test(u.username || ""), admin: /admin|staff|mod/i.test(u.class || ""),
      email: emailCategory(u.email), verified: !!u.isEmailVerified, discord: !!u.discordId, twitch: !!u.twitchId,
      login: String(u.camfrogUsername || "").trim().toLowerCase(), balance: Number(u.points_balance) || 0,
      created: ms(u.created_at), archived: u.archived_at != null,
      activeN: 0, activeDays: new Set(), lastActive: 0, lastPresence: 0, tips: 0, purchases: 0, passiveIn: 0,
      badges: 0, cosmetics: 0, roles: [], holds: new Set(), cfSeen: 0, cpRefs: 0, dupOf: null, dupWhy: null, ghost: false,
    });
  }
  const bw = new Map();
  if (await tableExists("bonus_winners")) for (const r of await getQuery("SELECT transactionId, type FROM bonus_winners")) bw.set(r.transactionId, r.type);
  const hasCp = await hasColumn("transactions", "counterparty");
  const txs = await getQuery(`SELECT transactionId, userId, type, points, timestamp${hasCp ? ", counterparty" : ""} FROM transactions`);
  for (const t of txs) {
    const f = F.get(t.userId);
    if (t.counterparty && F.has(t.counterparty) && t.counterparty !== t.userId) F.get(t.counterparty).cpRefs++;
    if (!f) continue;
    const type = (t.type === "bonus win" && bw.get(t.transactionId)) || t.type || "";
    const p = Number(t.points) || 0, when = ms(t.timestamp);
    if (RESTORE_GUARD.test(type)) continue;
    if (TIP.test(type)) f.tips++;
    if (PURCHASE.test(type)) f.purchases++;
    const active = (p < 0 && !SYSTEM_DEBIT.test(type)) || (p > 0 && ACTIVE_CREDIT.test(type));
    if (active) { f.activeN++; f.activeDays.add(String(t.timestamp || "").slice(0, 10)); if (when > f.lastActive) f.lastActive = when; }
    else if (p > 0) { f.passiveIn += p; if (PRESENCE_CREDIT.test(type) && when > f.lastPresence) f.lastPresence = when; }
  }
  const each = async (table, col, sql, fn) => {
    if (!(await tableExists(table)) || (col && !(await hasColumn(table, col)))) return;
    for (const r of await getQuery(sql)) { const f = F.get(r.id); if (f) fn(f, r); }
  };
  await each("user_badges", "badgeId", "SELECT userId AS id, badgeId FROM user_badges", (f, r) => { if (!AUTO_BADGES.has(r.badgeId)) f.badges++; });
  await each("user_cosmetics", "source", "SELECT user_id AS id, source FROM user_cosmetics", (f, r) => { if (r.source !== "level") f.cosmetics++; });
  await each("user_roles", "role", "SELECT userId AS id, role FROM user_roles", (f, r) => f.roles.push(r.role));
  await each("rooms_registry", "owner_user_id", "SELECT owner_user_id AS id FROM rooms_registry", (f) => f.holds.add("room owner"));
  await each("stage_slots", "status", "SELECT userId AS id FROM stage_slots WHERE status != 'ended' OR settled = 0", (f) => f.holds.add("stage slot"));
  await each("shop_orders", "status", "SELECT buyer_id AS id FROM shop_orders WHERE status NOT IN ('completed','refunded','cancelled','closed','resolved') UNION SELECT seller_id FROM shop_orders WHERE status NOT IN ('completed','refunded','cancelled','closed','resolved')", (f) => f.holds.add("open shop order"));
  await each("prizes", "seller_id", "SELECT seller_id AS id FROM prizes WHERE seller_id IS NOT NULL AND COALESCE(status,'active') IN ('active','pending','review')", (f) => f.holds.add("shop listing"));
  await each("cosmetic_listings", "status", "SELECT seller_id AS id FROM cosmetic_listings WHERE status = 'active'", (f) => f.holds.add("cosmetic listing"));
  if (await tableExists("markets")) {
    await each("market_orders", "market_id", "SELECT o.user_id AS id FROM market_orders o JOIN markets m ON m.id = o.market_id WHERE m.status = 'open' OR o.status = 'pending'", (f) => f.holds.add("market order"));
  }
  await each("pending_camfrog_links", "expires_at", `SELECT userId AS id FROM pending_camfrog_links WHERE expires_at > '${new Date(now).toISOString().replace("T", " ").slice(0, 19)}'`, (f) => f.holds.add("pending Camfrog link"));
  await each("welcome_bonus", "state", `SELECT userId AS id FROM welcome_bonus WHERE state = 'pending' AND created > ${now - welcomeDays * DAY}`, (f) => f.holds.add("pending welcome bonus"));

  // Pepe's copies on the site (stashes/loans snapshot, market/bounty/wager mirrors, Camfrog user stats)
  const siteBot = { loans: null, pvaults: null, markets: { markets: [] }, bounties: { bounties: [] }, wagers: { wagers: [] } };
  if (await tableExists("wallet_snapshots")) {
    for (const r of await getQuery("SELECT key, data FROM wallet_snapshots")) {
      const d = safeJson(r.data, {});
      if (r.key === "loans") siteBot.loans = d;
      if (r.key === "stashes") siteBot.pvaults = { vaults: d.stashes || [] };
    }
  }
  for (const [t, k] of [["markets", "markets"], ["bounties", "bounties"], ["wagers", "wagers"]]) {
    if (await tableExists(t)) for (const r of await getQuery(`SELECT data, status FROM ${t}`)) {
      const d = safeJson(r.data, {}); if (d && typeof d === "object") { d.status = d.status || r.status; siteBot[k][k].push(d); }
    }
  }
  const facts = [botFacts(siteBot), botFacts(bot)];
  if (await tableExists("camfrog_userstats")) {
    for (const r of await getQuery("SELECT login, data FROM camfrog_userstats")) {
      const d = safeJson(r.data, {}); const l = String(r.login || "").toLowerCase();
      const t = Math.max(ms(d.last), ms(d.c && d.c.last), ms(d.m && d.m.last));
      if (t > (facts[0].seen.get(l) || 0)) facts[0].seen.set(l, t);
    }
  }
  const byLogin = new Map(), usernames = new Set();
  for (const f of F.values()) {
    usernames.add(String(f.username || "").toLowerCase());
    if (f.login) { if (!byLogin.has(f.login)) byLogin.set(f.login, []); byLogin.get(f.login).push(f); }
  }
  // Same Camfrog login on several accounts: the primary is the real (non-CF) account, else the oldest.
  // The others are duplicates - merged into the primary (mergeDuplicate), never reclaimed.
  for (const group of byLogin.values()) {
    if (group.length < 2) continue;
    const sorted = group.slice().sort((a, b) => (a.isCF - b.isCF) || (a.created - b.created));
    for (const d of sorted.slice(1)) { d.dupOf = sorted[0].userId; d.dupWhy = `same Camfrog login as ${sorted[0].username}`; }
  }
  const alias = facts[1].alias;
  for (const f of F.values()) {
    // a Camfrog login that is one of Pepe's aliases of another login with its own account
    const canon = f.login && alias.get(f.login);
    if (canon && canon !== f.login && byLogin.has(canon) && !f.dupOf) {
      f.dupWhy = `Camfrog alias of ${canon}`; f.dupOf = byLogin.get(canon).slice().sort((a, b) => (a.isCF - b.isCF) || (a.created - b.created))[0].userId;
    }
    // Pepe keys loans/stashes/gangs by Camfrog login: those belong to the person (the primary account),
    // so a duplicate copy only picks up what names its own PATV username
    const keys = (f.dupOf ? [String(f.username || "").toLowerCase()] : [f.login, String(f.username || "").toLowerCase()]).filter(Boolean);
    for (const fx of facts) {
      for (const k of keys) for (const why of fx.holds.get(k) || []) f.holds.add(why);
      if (f.login) f.cfSeen = Math.max(f.cfSeen, fx.seen.get(f.login) || 0);
    }
    // ownerless ghost: an auto account with no Camfrog login, or whose "login" is really a PATV
    // account name (Pepe used to create these from "CFxxxxxxxx" names - 1.99az stopped it)
    if (f.login && SYSTEM_LOGINS.has(f.login)) f.holds.add("Pepe's own login");
  }
  for (const f of F.values()) {
    f.ghost = f.isCF && (!f.login || (CF_RANDOM_LOGIN.test(f.login) && (usernames.has(f.login) || !f.cfSeen)));
  }
  return [...F.values()].map((f) => Object.assign(f, { activeDays: f.activeDays.size }));
}

/** Tier for one account: {tier, why}. */
function classify(f, o = {}, now = Date.now()) {
  o = Object.assign({}, DEFAULTS, o);
  if (f.archived) return { tier: "archived", why: "already archived" };
  const ex = [];
  if (f.admin) ex.push("admin/staff");
  if (f.roles && f.roles.length) ex.push("role: " + f.roles.join(","));
  for (const h of f.holds) ex.push(h);
  if (f.balance < 0) ex.push("negative balance");
  if (ex.length) return { tier: "X", why: ex.join("; ") };
  if (f.dupOf) return { tier: "M", why: "duplicate: " + f.dupWhy + " - merge into it" };
  const last = Math.max(f.created, f.lastActive, f.lastPresence, f.cfSeen);
  const idle = (now - last) / DAY;
  const earned = f.tips > 0 || f.purchases > 0 || f.badges > 0 || f.cosmetics > 0;
  const linked = f.discord || f.twitch;
  if (f.ghost && f.activeN === 0 && !earned && !linked) return { tier: "G", why: `ownerless ghost (${f.login ? "its login is a PATV account name, never seen in Camfrog" : "no Camfrog login"})` };
  if (f.isCF && !linked && !earned && f.activeN === 0 && idle >= o.tierADays) return { tier: "A", why: `no own activity, unseen ${Math.floor(idle)}d` };
  if (idle < o.dormantDays) return { tier: "active", why: `seen ${Math.floor(idle)}d ago` };
  const low = f.activeN <= o.lowMax && f.activeDays <= o.lowDays;
  if (f.isCF && !linked && !earned && low) return { tier: "B", why: `${f.activeN} action(s), unseen ${Math.floor(idle)}d` };
  if (!f.isCF && !linked && !f.login && !earned && low && (JUNK_EMAIL.has(f.email) || !f.verified)) {
    return { tier: "C", why: `${f.email}${f.verified ? "" : "/unverified"} email, no link, ${f.activeN} action(s), unseen ${Math.floor(idle)}d` };
  }
  // made by the Twitch/Discord bot (placeholder email, the platform id is the only identity), never did
  // anything itself. Kept apart from A: the person CAN come back by signing in with Twitch/Discord.
  if (!f.isCF && linked && !f.login && f.email === "no-at" && f.activeN === 0 && !earned) {
    return { tier: "A2", why: `${f.twitch ? "Twitch" : "Discord"}-bot auto account, no own activity, unseen ${Math.floor(idle)}d` };
  }
  return { tier: "D", why: `dormant ${Math.floor(idle)}d, real (${[linked && "linked", f.login && "camfrog", earned && "earned/tips/purchases", f.activeN > o.lowMax && f.activeN + " actions"].filter(Boolean).join(", ") || "history"})` };
}

/** Total PAT supply the way /api/stats/supply counts it. */
async function supply() {
  const w = await getQuery("SELECT COALESCE(SUM(points_balance), 0) AS w FROM users");
  let j = 0, pools = 0;
  if (await tableExists("jackpot_rakes")) j = Number((await getQuery("SELECT COALESCE(SUM(amount), 0) AS j FROM jackpot_rakes"))[0].j) || 0;
  if (await tableExists("supply_snapshot")) {
    const s = await getQuery("SELECT pools FROM supply_snapshot WHERE id = 1");
    for (const p of safeJson(s[0] && s[0].pools, [])) pools += Math.max(0, Math.floor(Number(p.amount) || 0));
  }
  const wallets = Math.floor(Number(w[0].w) || 0);
  return { wallets, jackpot: j, pools, total: wallets + j + pools };
}

/** Classify everyone. Returns {rows: [{f, tier, why}], tiers: {tier: {n, pat}}, supply}. */
async function plan(opts = {}) {
  const now = opts.now || Date.now();
  const facts = opts.facts || (await gather({ now, bot: opts.bot, welcomeDays: opts.welcomeDays }));
  const rows = facts.map((f) => Object.assign({ f }, classify(f, opts, now)));
  const tiers = {};
  for (const r of rows) {
    const t = tiers[r.tier] || (tiers[r.tier] = { n: 0, pat: 0 });
    t.n++; t.pat += Math.max(0, Math.floor(r.f.balance));
  }
  return { rows, tiers, supply: opts.supply || (await supply()), facts };
}

/** Archive one account: reclaim its whole-PAT balance to the Reserve. Idempotent per account. */
async function archiveOne(userId, { runId, tier, why, graceDays = DEFAULTS.graceDays, now = Date.now() } = {}) {
  await ensure();
  return tx(async () => {
    const u = (await getQuery(`SELECT userId, username, displayname, camfrogUsername, points_balance, xp, level, created_at, archived_at
                               FROM users WHERE userId = ?`, [userId]))[0];
    if (!u || u.archived_at != null) return null;
    const bal = Number(u.points_balance) || 0;
    if (bal < 0) return null;
    const amt = Math.floor(bal);                                // sub-1 PAT dust stays on the row
    let txId = null, claimId = null;
    const r = await runQuery("UPDATE users SET archived_at = ?, points_balance = points_balance - ? WHERE userId = ? AND archived_at IS NULL", [now, amt, userId]);
    if (!r.changes) return null;
    if (amt > 0) {
      txId = uuidv4(); claimId = uuidv4();
      await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
                     [txId, userId, "stale-reclaim", -amt]);
      await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                     [claimId, "stale_reclaim", userId, `stale account archived (${tier}, run ${runId})`, -amt]);
    }
    const snap = JSON.stringify({ username: u.username, displayname: u.displayname, camfrog: u.camfrogUsername, xp: u.xp, level: u.level, created_at: u.created_at });
    await runQuery(`INSERT INTO account_archive (userId, run_id, tier, reason, archived_at, balance, reclaimed, reclaim_tx, reclaim_claim, purge_after, snapshot)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(userId) DO UPDATE SET run_id = excluded.run_id, tier = excluded.tier, reason = excluded.reason,
                      archived_at = excluded.archived_at, balance = excluded.balance, reclaimed = excluded.reclaimed,
                      reclaim_tx = excluded.reclaim_tx, reclaim_claim = excluded.reclaim_claim, purge_after = excluded.purge_after,
                      restored_at = NULL, restored_via = NULL, restore_tx = NULL, restore_claim = NULL, snapshot = excluded.snapshot`,
                   [userId, runId, tier, String(why || "").slice(0, 300), now, bal, amt, txId, claimId,
                    tier === "A" ? now + graceDays * DAY : null, snap]);
    return { userId, reclaimed: amt };
  });
}

/** Give an archived account everything back. Returns {restored} or null when it isn't archived. */
async function restore(userId, via = "manual") {
  if (!userId || !(await ensure())) return null;
  return tx(async () => {
    const u = (await getQuery("SELECT archived_at FROM users WHERE userId = ?", [userId]))[0];
    if (!u || u.archived_at == null) return null;
    const a = (await getQuery("SELECT reclaimed FROM account_archive WHERE userId = ? AND restored_at IS NULL AND purged_at IS NULL", [userId]))[0];
    const amt = a ? Math.max(0, Math.floor(Number(a.reclaimed) || 0)) : 0;
    const r = await runQuery("UPDATE users SET archived_at = NULL, points_balance = points_balance + ? WHERE userId = ? AND archived_at IS NOT NULL", [amt, userId]);
    if (!r.changes) return null;
    let txId = null, claimId = null;
    if (amt > 0) {
      txId = uuidv4(); claimId = uuidv4();
      await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)", [txId, userId, "stale-restore", amt]);
      await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                     [claimId, "stale_restore", userId, `archived account restored (${String(via).slice(0, 40)})`, amt]);
    }
    if (a) await runQuery("UPDATE account_archive SET restored_at = ?, restored_via = ?, restore_tx = ?, restore_claim = ? WHERE userId = ?",
                          [Date.now(), String(via).slice(0, 40), txId, claimId, userId]);
    console.log(`[stale] restored ${userId} (+${amt} PAT, via ${via})`);
    return { restored: amt };
  });
}

/** For sign-in / lookup paths: restore when the row (or id) is archived. Never throws. */
async function touch(rowOrId, via) {
  try {
    const row = typeof rowOrId === "string" ? null : rowOrId;
    const id = row ? row.userId : rowOrId;
    if (!id) return null;
    if (row && "archived_at" in row && row.archived_at == null) return null;
    if (!row || !("archived_at" in row)) {
      if (!(await ensure())) return null;
      const r = (await getQuery("SELECT archived_at FROM users WHERE userId = ?", [id]))[0];
      if (!r || r.archived_at == null) return null;
    }
    return await restore(id, via);
  } catch (e) { console.error("[stale] touch:", e.message); return null; }
}

// Rows an account owns that are not part of the PAT ledger (removed on purge).
const PURGE_TABLES = [["user_badges", "userId"], ["user_badge_showcase", "user_id"], ["user_cosmetics", "user_id"],
  ["user_cosmetic_equips", "user_id"], ["inbox", "user_id"], ["inbox_prefs", "user_id"], ["profile_layout", "user_id"],
  ["shop_prefs", "user_id"], ["welcome_bonus", "userId"], ["welcome_keys", "userId"], ["welcome_activity", "userId"],
  ["tipjar_seen", "userId"], ["pending_camfrog_links", "userId"], ["achievement_feed", "userId"], ["user_roles", "userId"]];

/** Hard-delete tier A accounts whose grace period is over and which are still archived and empty. */
async function purge({ now = Date.now(), dryRun = true, bot = null } = {}) {
  if (!(await hasColumn("users", "archived_at")) || !(await tableExists("account_archive"))) return { due: 0, purged: 0, skipped: [] };
  const due = await getQuery(`SELECT a.userId FROM account_archive a JOIN users u ON u.userId = a.userId
    WHERE a.tier = 'A' AND a.purge_after IS NOT NULL AND a.purge_after <= ? AND a.restored_at IS NULL AND a.purged_at IS NULL
      AND u.archived_at IS NOT NULL AND u.points_balance < 1`, [now]);
  if (!due.length) return { due: 0, purged: 0, skipped: [] };
  const facts = new Map((await gather({ now, bot })).map((f) => [f.userId, f]));
  const out = { due: due.length, purged: 0, skipped: [] };
  for (const { userId } of due) {
    const f = facts.get(userId);
    if (f && (f.holds.size || f.cpRefs)) { out.skipped.push({ userId, why: [...f.holds].join(",") || "counterparty in others' history" }); continue; }
    if (dryRun) { out.purged++; continue; }
    await tx(async () => {
      for (const [t, c] of PURGE_TABLES) if ((await tableExists(t)) && (await hasColumn(t, c))) await runQuery(`DELETE FROM ${t} WHERE ${c} = ?`, [userId]);
      await runQuery("DELETE FROM users WHERE userId = ? AND archived_at IS NOT NULL AND points_balance < 1", [userId]);
      await runQuery("UPDATE account_archive SET purged_at = ? WHERE userId = ?", [now, userId]);
    });
    out.purged++;
  }
  return out;
}

/** Merge a duplicate account into its primary: balance, XP, history and owned rows move, the copy goes. */
async function mergeDuplicate(dupId, primaryId) {
  if (!dupId || !primaryId || dupId === primaryId) return null;
  const { moveUserRows } = require("./accountMerge");
  return tx(async () => {
    const d = (await getQuery("SELECT userId, username, points_balance, xp, level FROM users WHERE userId = ?", [dupId]))[0];
    const p = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [primaryId]))[0];
    if (!d || !p) return null;
    const bal = Number(d.points_balance) || 0, xp = Number(d.xp) || 0;
    await runQuery("UPDATE users SET points_balance = points_balance + ?, xp = xp + ?, level = MAX(COALESCE(level, 0), ?) WHERE userId = ?",
                   [bal, xp, Number(d.level) || 0, primaryId]);
    await runQuery("UPDATE transactions SET userId = ? WHERE userId = ?", [primaryId, dupId]);
    if (await hasColumn("transactions", "counterparty")) await runQuery("UPDATE transactions SET counterparty = ? WHERE counterparty = ?", [primaryId, dupId]);
    const moved = await moveUserRows(dupId, primaryId);
    if (bal) await runQuery("INSERT INTO transactions (transactionId, userId, type, points, note) VALUES (?, ?, ?, ?, ?)",
                            [uuidv4(), primaryId, "account merge", 0, `duplicate ${d.username} merged (${bal} PAT, ${xp} XP)`]).catch(() => {});
    await runQuery("DELETE FROM users WHERE userId = ?", [dupId]);
    return { dup: d.username, into: p.username, balance: bal, xp, moved };
  });
}

/** SQL condition for "shown on leaderboards / counted as a member" ("1 = 1" until the column exists). */
const LIVE = (alias) => (columnReady ? `${alias ? alias + "." : ""}archived_at IS NULL` : "1 = 1");

module.exports = { DEFAULTS, CF_RANDOM, emailCategory, ms, ensure, gather, classify, plan, supply, botFacts,
  archiveOne, restore, touch, purge, mergeDuplicate, LIVE, PURGE_TABLES };
