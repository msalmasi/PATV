// Display names (1.99az): every account has one, and we know whether the user chose it.
//
//   users.displayname       what the site shows (wheel, profile, rankings, tables, tip jar, feeds)
//   users.displayname_auto  1 = picked by us (sign-up source / Pepe's Camfrog display name) and may be
//                           refreshed later; 0 = the user set it on their profile, never overwritten
//
// Sources, best first: the Camfrog display name Pepe sees in the room user list, the Discord or
// Twitch display name, the Camfrog login, the PATV username. Pepe's auto accounts are named
// "CF" + 8 random characters - that is never a display name if anything better is known.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const MAX_LEN = 32;
// The generator makes "CF" + 8 of [a-z0-9]. As a display name it's matched case-sensitively (a
// person may well call themselves "CFredSmith"); Camfrog logins are stored lowercased, so for a
// login the loose form applies.
const CF_RANDOM = /^CF[a-z0-9]{8}$/;
const CF_RANDOM_LOGIN = /^cf[a-z0-9]{8}$/i;
const CF_GLOB = "CF[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]";

// Camfrog display names can carry <...> markup; strip it, plus control / zero-width / bidi
// characters, collapse whitespace and cap the length (by code point, never splitting a pair).
function strip(name) {
  if (name == null) return "";
  return String(name)
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clean(name) {
  let s = strip(name);
  const cps = Array.from(s);
  if (cps.length > MAX_LEN) s = cps.slice(0, MAX_LEN).join("").trim();
  return s;
}

function isCfRandom(name, login = false) {
  return (login ? CF_RANDOM_LOGIN : CF_RANDOM).test(String(name || ""));
}

// A usable automatic name: non-empty after cleaning and not a random CF account name.
function usable(name, login = false) {
  const c = clean(name);
  return c && !isCfRandom(c, login) ? c : "";
}

// The automatic display name for an account and where it came from.
// src: { camfrogDisplay, discordName, twitchName, camfrogUsername, username }
function pickAuto(src) {
  src = src || {};
  const order = [
    ["camfrog_display", src.camfrogDisplay],
    ["discord", src.discordName],
    ["twitch", src.twitchName],
    ["camfrog_login", src.camfrogUsername],
    ["username", src.username],
  ];
  for (const [source, v] of order) {
    const c = usable(v, source === "camfrog_login");
    if (c) return { name: c, source };
  }
  return { name: clean(src.username) || String(src.username || ""), source: "username" };
}

// Is this stored displayname missing or junk (so the account needs an automatic one)?
function needsAuto(row) {
  const dn = clean(row && row.displayname);
  return !dn || isCfRandom(dn);
}

// ── schema ──────────────────────────────────────────────────────────────────────────────────────
// Adds users.displayname_auto and, once, marks which EXISTING names are automatic: empty, a random
// CF name, or equal to the username / Camfrog login / Discord / Twitch name (what sign-up set).
// Anything else was typed by someone and stays user-set.
let readyP = null;
function ready() {
  if (!readyP) {
    readyP = (async () => {
      try {
        await runQuery("ALTER TABLE users ADD COLUMN displayname_auto INTEGER NOT NULL DEFAULT 0");
      } catch (e) {
        if (!/duplicate column/i.test(String(e && e.message))) throw e;
      }
      await runQuery("CREATE TABLE IF NOT EXISTS displayname_meta (k TEXT PRIMARY KEY, v TEXT)");
      const done = await getQuery("SELECT v FROM displayname_meta WHERE k = 'auto_marked'");
      if (!done.length) {
        await runQuery(
          `UPDATE users SET displayname_auto = 1
            WHERE displayname IS NULL OR TRIM(displayname) = ''
               OR LOWER(displayname) = LOWER(username)
               OR LOWER(displayname) = LOWER(COALESCE(camfrogUsername, ''))
               OR LOWER(displayname) = LOWER(COALESCE(discordUsername, ''))
               OR LOWER(displayname) = LOWER(COALESCE(twitchDisplayname, ''))
               OR displayname GLOB '${CF_GLOB}'`
        );
        await runQuery("INSERT OR REPLACE INTO displayname_meta (k, v) VALUES ('auto_marked', ?)", [new Date().toISOString()]);
      }
    })().catch((e) => {
      readyP = null;          // users table not there yet (fresh DB): try again on the next call
      throw e;
    });
  }
  return readyP;
}

// ── backfill ────────────────────────────────────────────────────────────────────────────────────
// Every account with a missing / random-CF display name, or an automatic one that a better source
// now beats. camfrogNames: optional Map/object lowercased Camfrog login -> Camfrog display name.
// Returns { changes: [{userId, username, before, after, source}], bySource, unresolved }. dryRun writes nothing;
// otherwise all changes go in ONE transaction.
async function backfill({ dryRun = true, camfrogNames = null } = {}) {
  await ready();
  const cfMap = toMap(camfrogNames);
  const rows = await getQuery(
    "SELECT userId, username, displayname, displayname_auto, camfrogUsername, discordUsername, twitchDisplayname FROM users"
  );
  const changes = [], unresolved = [];
  for (const r of rows) {
    const junk = needsAuto(r);
    if (!junk && !r.displayname_auto) continue;                   // user-set: never touched
    const pick = pickAuto({
      camfrogDisplay: r.camfrogUsername ? cfMap.get(String(r.camfrogUsername).toLowerCase()) : "",
      discordName: r.discordUsername,
      twitchName: r.twitchDisplayname,
      camfrogUsername: r.camfrogUsername,
      username: r.username,
    });
    // A fine automatic name is only upgraded by Pepe's Camfrog display name (no churn otherwise).
    if (!junk && pick.source !== "camfrog_display") continue;
    if (r.displayname === pick.name) continue;
    if (isCfRandom(pick.name)) { unresolved.push(r.username); continue; }   // nothing better known
    changes.push({ userId: r.userId, username: r.username, before: r.displayname, after: pick.name, source: pick.source });
  }
  const bySource = {};
  for (const c of changes) bySource[c.source] = (bySource[c.source] || 0) + 1;
  if (!dryRun && changes.length) {
    await runQuery("BEGIN IMMEDIATE");
    try {
      for (const c of changes) {
        // only if it hasn't changed since it was read (a user saving their own name meanwhile wins)
        await runQuery("UPDATE users SET displayname = ?, displayname_auto = 1 WHERE userId = ? AND displayname IS ?",
          [c.after, c.userId, c.before]);
      }
      await runQuery("COMMIT");
    } catch (e) {
      await runQuery("ROLLBACK").catch(() => {});
      throw e;
    }
  }
  return { changes, bySource, unresolved };
}

function toMap(m) {
  const out = new Map();
  if (!m) return out;
  const entries = m instanceof Map ? m.entries() : Object.entries(m);
  for (const [k, v] of entries) if (k && v) out.set(String(k).toLowerCase(), String(v));
  return out;
}

// ── Pepe's Camfrog display names ────────────────────────────────────────────────────────────────
// [{login, display}] from Pepe's room user lists. Updates ONLY automatic display names of the
// account(s) linked to that Camfrog login; user-set names are never touched. A display equal to the
// login (Camfrog shows no separate name) is accepted too: it replaces a random CF name.
const MAX_BATCH = 200;
async function applyCamfrogNames(list) {
  await ready();
  let updated = 0, skipped = 0;
  const items = Array.isArray(list) ? list.slice(0, MAX_BATCH) : [];
  for (const it of items) {
    const login = clean(it && it.login).toLowerCase();
    const display = usable(it && it.display);
    if (!login || !display) { skipped++; continue; }
    // Just the login again (no separate Camfrog name): only fills a missing / random-CF name, so a
    // linked web account keeps the username it signed up with.
    const onlyJunk = display.toLowerCase() === login;
    const r = await runQuery(
      `UPDATE users SET displayname = ?, displayname_auto = 1
        WHERE LOWER(camfrogUsername) = ? AND displayname IS NOT ?
          AND (displayname IS NULL OR TRIM(displayname) = '' OR displayname GLOB '${CF_GLOB}'
               ${onlyJunk ? "" : "OR displayname_auto = 1"})`,
      [display, login, display]
    );
    if (r && r.changes) updated += r.changes; else skipped++;
  }
  return { updated, skipped, received: items.length };
}

// A user typed a display name on their profile: it becomes theirs (auto = 0). An empty one hands
// the account back to the automatic name.
// Same rules as Pepe's !displayname (validate(), but a long name is cut rather than refused).
// Returns { displayname, auto } or { error } (nothing written), or null for an unknown account.
async function setByUser(userId, name) {
  await ready();
  const r = (await getQuery("SELECT username, displayname, camfrogUsername, discordUsername, twitchDisplayname FROM users WHERE userId = ?", [userId]))[0];
  if (!r) return null;
  let next, auto;
  if (clean(name)) {
    const v = validate(name, { truncate: true });
    if (!v.ok) return { error: v.error };
    next = v.name; auto = false;
  } else {
    next = pickAuto({ discordName: r.discordUsername, twitchName: r.twitchDisplayname, camfrogUsername: r.camfrogUsername, username: r.username }).name;
    auto = true;
  }
  await runQuery("UPDATE users SET displayname = ?, displayname_auto = ? WHERE userId = ?", [next, auto ? 1 : 0, userId]);
  if (r.displayname !== next) {
    await logChange({ userId, oldName: r.displayname, newName: next, auto, via: "web", actor: r.username }).catch(() => {});
  }
  return { displayname: next, auto };
}

// ── validation (shared by the profile edit page and Pepe's !displayname) ───────────────────────
// The rules: strip() (markup, control / zero-width / bidi characters, whitespace collapsed),
// something must be left, at most MAX_LEN characters, and not a random "CF" + 8 name (the Camfrog
// sync treats those as junk and would replace it). There is no uniqueness rule: display names are
// labels, accounts are told apart by username.
//   truncate: true  = the profile page (a long name is cut to MAX_LEN, as it always was)
//   truncate: false = refuse it with the reason (chat, where nobody would see it got cut)
// Returns { ok: true, name } or { ok: false, error }.
function validate(name, { truncate = false } = {}) {
  const raw = name == null ? "" : String(name);
  const full = strip(raw);
  if (!full) {
    return { ok: false, error: raw.trim() ? "nothing is left once markup and invisible characters are removed" : "the name is empty" };
  }
  if (!truncate && Array.from(full).length > MAX_LEN) {
    return { ok: false, error: `too long - ${MAX_LEN} characters at most` };
  }
  const c = clean(full);
  if (isCfRandom(c)) return { ok: false, error: "that looks like an automatic CF account name - pick something else" };
  return { ok: true, name: c };
}

// ── changes from Camfrog (Pepe's !displayname) ──────────────────────────────────────────────────
// One self-change per RATE_LIMIT_MS (counting profile-page changes too; admins aren't limited and
// don't use up the user's change). Every change is written to displayname_log.
const RATE_LIMIT_MS = 60 * 60 * 1000;

let logReadyP = null;
function logReady() {
  if (!logReadyP) {
    logReadyP = runQuery(
      `CREATE TABLE IF NOT EXISTS displayname_log (
         id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT NOT NULL, old_name TEXT, new_name TEXT,
         auto INTEGER NOT NULL DEFAULT 0, via TEXT NOT NULL, actor TEXT, by_admin INTEGER NOT NULL DEFAULT 0,
         at INTEGER NOT NULL)`
    ).then(() => runQuery("CREATE INDEX IF NOT EXISTS idx_displayname_log_user ON displayname_log (userId, at)"))
      .catch((e) => { logReadyP = null; throw e; });
  }
  return logReadyP;
}

async function logChange({ userId, oldName, newName, auto, via, actor, byAdmin, at }) {
  await logReady();
  await runQuery(
    "INSERT INTO displayname_log (userId, old_name, new_name, auto, via, actor, by_admin, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [userId, oldName == null ? null : String(oldName), newName, auto ? 1 : 0, via, actor || null, byAdmin ? 1 : 0, at || Date.now()]
  );
}

// The account linked to a Camfrog login (a real account ahead of a leftover random CF one).
async function findByCamfrog(login) {
  const l = String(login || "").trim().toLowerCase();
  if (!l) return null;
  const rows = await getQuery(
    `SELECT userId, username, displayname, displayname_auto, camfrogUsername, discordUsername, twitchDisplayname
       FROM users WHERE LOWER(camfrogUsername) = ? ORDER BY (username GLOB '${CF_GLOB}') ASC, rowid ASC LIMIT 1`, [l]);
  return rows[0] || null;
}

// action "get" | "set" | "reset" for the account linked to a Camfrog login. camfrogDisplay: the
// Camfrog display name Pepe sees for them (the best automatic name on a reset). Returns
// { status, body } for the route.
async function camfrogChange({ login, action = "get", name, actor, admin = false, camfrogDisplay, now = Date.now() } = {}) {
  await ready();
  await logReady();
  const u = await findByCamfrog(login);
  if (!u) return { status: 404, body: { ok: false, error: "no publicaccess.tv account is linked to that Camfrog name" } };
  const current = { ok: true, username: u.username, displayname: u.displayname || "", auto: !!u.displayname_auto };
  if (action === "get") return { status: 200, body: current };

  let next, auto;
  if (action === "reset") {
    next = pickAuto({ camfrogDisplay, discordName: u.discordUsername, twitchName: u.twitchDisplayname,
                      camfrogUsername: u.camfrogUsername, username: u.username }).name;
    auto = true;
  } else if (action === "set") {
    const v = validate(name, { truncate: false });
    if (!v.ok) return { status: 400, body: { ok: false, error: v.error } };
    next = v.name; auto = false;
  } else {
    return { status: 400, body: { ok: false, error: "unknown action" } };
  }
  if (u.displayname === next && !!u.displayname_auto === auto) {
    return { status: 200, body: Object.assign(current, { unchanged: true }) };
  }
  if (!admin) {
    const last = (await getQuery(
      "SELECT at FROM displayname_log WHERE userId = ? AND by_admin = 0 ORDER BY at DESC LIMIT 1", [u.userId]))[0];
    if (last && now - last.at < RATE_LIMIT_MS) {
      const mins = Math.max(1, Math.ceil((RATE_LIMIT_MS - (now - last.at)) / 60000));
      return { status: 429, body: { ok: false, error: `display names can change once an hour - try again in ${mins} min`, retryMin: mins } };
    }
  }
  await runQuery("UPDATE users SET displayname = ?, displayname_auto = ? WHERE userId = ?", [next, auto ? 1 : 0, u.userId]);
  await logChange({ userId: u.userId, oldName: u.displayname, newName: next, auto, via: "camfrog", actor, byAdmin: admin, at: now });
  console.log(`[displaynames] ${actor || "?"} ${admin ? "(admin) " : ""}set ${u.username}: ${JSON.stringify(u.displayname)} -> ${JSON.stringify(next)}${auto ? " (auto)" : ""}`);
  return { status: 200, body: { ok: true, username: u.username, displayname: next, auto, old: u.displayname || "" } };
}

// After an INSERT INTO users: mark the account's name automatic (and fill it if it came in empty).
async function markNewAccount(userId) {
  await ready();
  const r = (await getQuery("SELECT username, displayname, camfrogUsername, discordUsername, twitchDisplayname FROM users WHERE userId = ?", [userId]))[0];
  if (!r) return;
  const name = needsAuto(r)
    ? pickAuto({ discordName: r.discordUsername, twitchName: r.twitchDisplayname, camfrogUsername: r.camfrogUsername, username: r.username }).name
    : clean(r.displayname);
  await runQuery("UPDATE users SET displayname = ?, displayname_auto = 1 WHERE userId = ?", [name, userId]);
}

module.exports = { clean, isCfRandom, usable, pickAuto, needsAuto, ready, backfill, applyCamfrogNames, setByUser, markNewAccount,
  validate, logChange, findByCamfrog, camfrogChange, MAX_LEN, MAX_BATCH, RATE_LIMIT_MS };
