// loginrekey.js — 1.99tj: records follow the ACCOUNT, not the Camfrog login.
//
// The user's rule (2026-10-12): a PATV account isn't tied to a Camfrog account. When an account's Camfrog login changes
// (a !verify of a new name, an unlink, another account taking the name), everything keyed by the OLD login - gang
// membership, stashes, loans, bounties, GTF sheets, voice unlocks... - moves to the account's NEW key (its new login, or
// "u:<userId>" while it has none, the gangs' own convention). The old login seen again in chat is a brand-new, empty
// account: nothing of the old account can be found or paid through it.
//
//   login_changes        one row per change (userId, old/new login, old_key/new_key, via, the site's own re-key result).
//                        Pepe reads them (POST /api/users/login-changes {after}) and re-keys HIS records under the same
//                        id - keyed + journaled on his side, so a replay changes nothing.
//   login_rekey_archive  a value a re-key couldn't merge (the new key already had one) - kept, never lost.
//
// The site re-keys its own tables in the SAME transaction as the change: stashes (owner / members), held escrow holds
// (login), escrow game records (bounties / loans / wagers JSON), the capital cluster's records (markets / Reserve loans /
// requests JSON, Phase 3), GTF records + mirror + open ops (with a rev bump so
// Pepe's mirror follows), gang members / invites / boss, voice unlocks. PATV usernames inside records (user / username /
// users / userId fields) are never touched - they name the account, which didn't change.
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");

const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
const keyOf = (login, userId) => (low(login) ? low(login) : `u:${userId}`);
// fields that hold a PATV username / id, not a Camfrog login: never re-keyed
const NAME_FIELDS = new Set(["user", "username", "users", "user_id", "userId", "uid", "uids", "seller_username"]);

let readyP = null;
function ensure() {
  if (readyP) return readyP;
  readyP = (async () => {
    await runQuery(`CREATE TABLE IF NOT EXISTS login_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT NOT NULL, old_login TEXT, new_login TEXT, old_key TEXT NOT NULL,
      new_key TEXT NOT NULL, at INTEGER NOT NULL, via TEXT NOT NULL, site_result TEXT)`);
    await runQuery(`CREATE TABLE IF NOT EXISTS login_rekey_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT, change_id INTEGER, tbl TEXT NOT NULL, rec_key TEXT, data TEXT, at INTEGER NOT NULL)`);
    return true;
  })().catch((e) => { readyP = null; throw e; });
  return readyP;
}
async function hasTable(name) {
  return (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name])).length > 0;
}

/**
 * Deep re-key of a JSON value: every string equal to `old` (any case) -> `nw`, every object key equal to `old` -> `nw`.
 * Fields in NAME_FIELDS are left alone. A key collision keeps the value already under `nw` and reports the other in
 * out.archived. Lists of strings are de-duplicated after the swap. -> the new value (out.n counts the swaps)
 */
function rekeyValue(v, old, nw, out, path = "") {
  if (typeof v === "string") {
    if (low(v) === old) { out.n++; return nw; }
    return v;
  }
  if (Array.isArray(v)) {
    const r = v.map((x, i) => rekeyValue(x, old, nw, out, `${path}[${i}]`));
    if (r.every((x) => typeof x === "string")) return r.filter((x, i) => r.indexOf(x) === i);
    return r;
  }
  if (v && typeof v === "object") {
    const o = {};
    const entries = Object.entries(v);
    // keys that are already the new key go first, so a renamed key meets them (and never silently replaces them)
    entries.sort((a, b) => (low(a[0]) === old ? 1 : 0) - (low(b[0]) === old ? 1 : 0));
    for (const [k, x] of entries) {
      const val = NAME_FIELDS.has(k) ? x : rekeyValue(x, old, nw, out, `${path}.${k}`);
      if (low(k) === old) {
        out.n++;
        if (Object.prototype.hasOwnProperty.call(o, nw)) { out.archived.push({ path: `${path}.${k}`, value: val }); continue; }
        o[nw] = val;
      } else {
        o[k] = val;
      }
    }
    return o;
  }
  return v;
}
function rekeyJsonText(text, old, nw) {
  if (text == null || !String(text).toLowerCase().includes(old)) return null;
  let v;
  try { v = JSON.parse(text); } catch (e) { return null; }
  const out = { n: 0, archived: [] };
  const r = rekeyValue(v, old, nw, out);
  return out.n ? { text: JSON.stringify(r), n: out.n, archived: out.archived } : null;
}

/** Which of two records (JSON text) has more play: a GTF sheet by heists (+ arena / brawl wins), then loot, then size. */
function score(text) {
  let v = null;
  try { v = JSON.parse(text || "null"); } catch (e) { v = null; }
  const n = (k) => (v && typeof v[k] === "number" ? v[k] : 0);
  return [n("heists") + n("arena_wins") + n("brawl_wins"), n("loot"), String(text || "").length];
}
const more = (a, b) => { const x = score(a), y = score(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return true; };

/** Re-key the site's own login-keyed tables from oldKey to newKey. Run it inside a transaction. -> [change lines] */
async function rekeySite(oldKey, newKey, changeId = null) {
  const old = low(oldKey), nw = String(newKey);
  const log = [];
  const archive = async (tbl, recKey, data) => {
    await runQuery("INSERT INTO login_rekey_archive (change_id, tbl, rec_key, data, at) VALUES (?, ?, ?, ?, ?)",
                   [changeId, tbl, recKey, typeof data === "string" ? data : JSON.stringify(data), Date.now()]);
    log.push({ table: tbl, action: "archived (the new key already had one)", key: recKey });
  };
  if (await hasTable("stashes")) {
    for (const r of await getQuery("SELECT id FROM stashes WHERE lower(owner) = ?", [old])) {
      await runQuery("UPDATE stashes SET owner = ?, updated = ? WHERE id = ?", [nw, Date.now(), r.id]);
      log.push({ table: "stashes", action: "owner", key: r.id, from: old, to: nw });
    }
  }
  if (await hasTable("stash_members")) {
    for (const r of await getQuery("SELECT stash_id FROM stash_members WHERE lower(login) = ?", [old])) {
      await runQuery("INSERT OR IGNORE INTO stash_members (stash_id, login) VALUES (?, ?)", [r.stash_id, nw]);
      await runQuery("DELETE FROM stash_members WHERE stash_id = ? AND lower(login) = ?", [r.stash_id, old]);
      log.push({ table: "stash_members", action: "member", key: r.stash_id, from: old, to: nw });
    }
  }
  if (await hasTable("escrow_holds")) {
    for (const r of await getQuery("SELECT id FROM escrow_holds WHERE state = 'held' AND lower(login) = ?", [old])) {
      await runQuery("UPDATE escrow_holds SET login = ? WHERE id = ?", [nw, r.id]);
      log.push({ table: "escrow_holds", action: "login", key: r.id, from: old, to: nw });
    }
  }
  if (await hasTable("escrow_games")) {
    for (const r of await getQuery("SELECT game, id, data FROM escrow_games WHERE lower(data) LIKE ?", [`%${old}%`])) {
      const x = rekeyJsonText(r.data, old, nw);
      if (!x) continue;
      await runQuery("UPDATE escrow_games SET data = ?, updated = ? WHERE game = ? AND id = ?", [x.text, Date.now(), r.game, r.id]);
      log.push({ table: "escrow_games", action: `${x.n} reference(s)`, key: `${r.game}:${r.id}` });
      for (const a of x.archived) await archive("escrow_games", `${r.game}:${r.id}${a.path}`, a.value);
    }
  }
  if (await hasTable("capital_records")) {
    // Phase 3: the LMSR markets (positions by login, creator, judge), Reserve loans (borrower login) and LR requests (nick).
    // The accounts inside them (uids / users / uid) aren't touched - they name the account, which didn't change.
    for (const r of await getQuery("SELECT kind, id, data FROM capital_records WHERE lower(data) LIKE ?", [`%${old}%`])) {
      const x = rekeyJsonText(r.data, old, nw);
      if (!x) continue;
      await runQuery("UPDATE capital_records SET data = ?, updated = ? WHERE kind = ? AND id = ?", [x.text, Date.now(), r.kind, r.id]);
      log.push({ table: "capital_records", action: `${x.n} reference(s)`, key: `${r.kind}:${r.id}` });
      for (const a of x.archived) await archive("capital_records", `${r.kind}:${r.id}${a.path}`, a.value);
    }
    if ((await getQuery("SELECT 1 FROM capital_records WHERE lower(data) LIKE ? LIMIT 1", [`%${nw.toLowerCase()}%`])).length) {
      await runQuery("INSERT INTO capital_meta (key, value) VALUES ('rev', '0') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").catch(() => {});
    }
  }
  if (await hasTable("gtf_records")) {
    let rev = 0;
    const m = (await getQuery("SELECT value FROM gtf_meta WHERE key = 'rev'").catch(() => []))[0];
    try { rev = Number(JSON.parse(m ? m.value : "0")) || 0; } catch (e) { rev = 0; }
    const rev0 = rev;
    for (const r of await getQuery("SELECT kind, id, data FROM gtf_records WHERE deleted = 0 AND lower(id) = ?", [old])) {
      const data = (rekeyJsonText(r.data, old, nw) || { text: r.data }).text;
      const there = (await getQuery("SELECT data FROM gtf_records WHERE kind = ? AND id = ? AND deleted = 0", [r.kind, nw]))[0];
      let keep = data;
      if (there) {
        // the account already has a record under its new login (it played under both): keep the one with more play (Pepe
        // merges the counters of both into it and puts the result), archive the other
        const mine = more(data, there.data);
        keep = mine ? data : there.data;
        await archive("gtf_records", `${r.kind}:${mine ? nw : old}`, mine ? there.data : data);
      }
      await runQuery(`INSERT INTO gtf_records (kind, id, data, rev, deleted, updated) VALUES (?, ?, ?, ?, 0, ?)
                      ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, rev = excluded.rev, deleted = 0, updated = excluded.updated`,
                     [r.kind, nw, keep, ++rev, Date.now()]);
      await runQuery("UPDATE gtf_records SET data = NULL, deleted = 1, rev = ?, updated = ? WHERE kind = ? AND id = ?", [++rev, Date.now(), r.kind, r.id]);
      log.push({ table: "gtf_records", action: "moved", key: r.kind, from: r.id, to: nw });
    }
    for (const r of await getQuery("SELECT kind, id, data FROM gtf_records WHERE deleted = 0 AND lower(data) LIKE ?", [`%${old}%`])) {
      const x = rekeyJsonText(r.data, old, nw);
      if (!x) continue;
      await runQuery("UPDATE gtf_records SET data = ?, rev = ?, updated = ? WHERE kind = ? AND id = ?", [x.text, ++rev, Date.now(), r.kind, r.id]);
      log.push({ table: "gtf_records", action: `${x.n} reference(s)`, key: `${r.kind}:${r.id}` });
      for (const a of x.archived) await archive("gtf_records", `${r.kind}:${r.id}${a.path}`, a.value);
    }
    if (rev !== rev0) {
      await runQuery("INSERT INTO gtf_meta (key, value) VALUES ('rev', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(rev)]);
    }
  }
  if (await hasTable("gtf_mirror")) {
    for (const r of await getQuery("SELECT kind, id, data, display FROM gtf_mirror WHERE lower(id) = ?", [old])) {
      const data = (rekeyJsonText(r.data, old, nw) || { text: r.data }).text;
      const there = (await getQuery("SELECT data FROM gtf_mirror WHERE kind = ? AND id = ?", [r.kind, nw]))[0];
      if (there && !more(data, there.data)) {
        await archive("gtf_mirror", `${r.kind}:${old}`, data);
      } else {
        if (there) await archive("gtf_mirror", `${r.kind}:${nw}`, there.data);
        await runQuery(`INSERT INTO gtf_mirror (kind, id, data, display, updated) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, display = excluded.display, updated = excluded.updated`,
                       [r.kind, nw, data, r.display, Date.now()]);
      }
      await runQuery("DELETE FROM gtf_mirror WHERE kind = ? AND id = ?", [r.kind, r.id]);
      log.push({ table: "gtf_mirror", action: "moved", key: r.kind, from: r.id, to: nw });
    }
  }
  if (await hasTable("gtf_ops")) {
    const r = await runQuery("UPDATE gtf_ops SET login = ? WHERE acked IS NULL AND lower(login) = ?", [nw, old]);
    if (r && r.changes) log.push({ table: "gtf_ops", action: `${r.changes} open op(s)`, from: old, to: nw });
  }
  if (await hasTable("heist_market_ops")) {
    // 1.99tt: the heist market's item moves Pepe hasn't applied yet go to the account's new sheet
    const r = await runQuery("UPDATE heist_market_ops SET login = ? WHERE done_at IS NULL AND lower(login) = ?", [nw, old]);
    if (r && r.changes) log.push({ table: "heist_market_ops", action: `${r.changes} open op(s)`, from: old, to: nw });
  }
  if (await hasTable("gang_members")) {
    for (const r of await getQuery("SELECT * FROM gang_members WHERE lower(member_key) = ?", [old])) {
      const there = (await getQuery("SELECT gid FROM gang_members WHERE member_key = ?", [nw]))[0];
      if (there) {
        await archive("gang_members", old, r);          // the account is already in a gang under its new login
        await runQuery("DELETE FROM gang_members WHERE member_key = ?", [r.member_key]);
      } else {
        await runQuery("UPDATE gang_members SET member_key = ? WHERE member_key = ?", [nw, r.member_key]);
        log.push({ table: "gang_members", action: "member", key: r.gid, from: r.member_key, to: nw });
      }
    }
    for (const r of await getQuery("SELECT gid FROM gangs WHERE lower(boss) = ?", [old])) {
      await runQuery("UPDATE gangs SET boss = ? WHERE gid = ?", [nw, r.gid]);
      log.push({ table: "gangs", action: "boss", key: r.gid, from: old, to: nw });
    }
    for (const col of ["withdrawn", "extra"]) {
      for (const r of await getQuery(`SELECT gid, ${col} AS v FROM gangs WHERE lower(${col}) LIKE ?`, [`%${old}%`])) {
        const x = rekeyJsonText(r.v, old, nw);
        if (!x) continue;
        await runQuery(`UPDATE gangs SET ${col} = ? WHERE gid = ?`, [x.text, r.gid]);
        log.push({ table: "gangs", action: `${col}: ${x.n} reference(s)`, key: r.gid });
        for (const a of x.archived) await archive("gangs", `${r.gid}.${col}${a.path}`, a.value);
      }
    }
  }
  if (await hasTable("gang_invites")) {
    for (const r of await getQuery("SELECT member_key FROM gang_invites WHERE lower(member_key) = ?", [old])) {
      await runQuery("INSERT OR IGNORE INTO gang_invites (member_key, gid, inviter_key, created) SELECT ?, gid, inviter_key, created FROM gang_invites WHERE member_key = ?", [nw, r.member_key]);
      await runQuery("DELETE FROM gang_invites WHERE member_key = ?", [r.member_key]);
      log.push({ table: "gang_invites", action: "invite", from: r.member_key, to: nw });
    }
    await runQuery("UPDATE gang_invites SET inviter_key = ? WHERE lower(inviter_key) = ?", [nw, old]);
  }
  if (await hasTable("ach_progress")) {
    // Phase 5: the achievement counters (achprogress.js) - merged like Pepe's own re-key (counters add, streaks keep the larger)
    for (const l of await require("./achprogress").rekeyInTx(old, nw, archive)) log.push(l);
  }
  if (await hasTable("voice_owned_logins")) {
    for (const r of await getQuery("SELECT voice_id FROM voice_owned_logins WHERE lower(login) = ?", [old])) {
      await runQuery("INSERT OR IGNORE INTO voice_owned_logins (login, voice_id, source, created) SELECT ?, voice_id, source, created FROM voice_owned_logins WHERE lower(login) = ? AND voice_id = ?", [nw, old, r.voice_id]);
      await runQuery("DELETE FROM voice_owned_logins WHERE lower(login) = ? AND voice_id = ?", [old, r.voice_id]);
      log.push({ table: "voice_owned_logins", action: "voice", key: r.voice_id, from: old, to: nw });
    }
  }
  return log;
}

/**
 * An account's Camfrog login changed (call it right after the users row changed). Records the change for Pepe and
 * re-keys the site's own tables, in one transaction. A change that keeps the key writes nothing. -> the change row id
 */
async function changed(userId, oldLogin, newLogin, via, { at = null } = {}) {
  const oldKey = keyOf(oldLogin, userId), newKey = keyOf(newLogin, userId);
  if (!userId || oldKey === newKey) return null;
  await ensure();
  return tx(async () => {
    const r = await runQuery(`INSERT INTO login_changes (userId, old_login, new_login, old_key, new_key, at, via) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                             [String(userId), low(oldLogin) || null, low(newLogin) || null, oldKey, newKey, Math.trunc(Number(at) || Date.now()), String(via).slice(0, 40)]);
    const id = r && (r.id || r.lastID);
    const log = await rekeySite(oldKey, newKey, id);
    await runQuery("UPDATE login_changes SET site_result = ? WHERE id = ?", [JSON.stringify(log).slice(0, 20000), id]);
    if (log.length) console.log(`[login-rekey] #${id} ${oldKey} -> ${newKey} (${userId}, ${via}): ${log.length} site change(s)`);
    return id;
  });
}

/** Never throws (a login change must not fail because of the re-key - it's logged; the tool can re-run it). */
async function changedSafe(userId, oldLogin, newLogin, via) {
  try { return await changed(userId, oldLogin, newLogin, via); } catch (e) {
    console.error(`[login-rekey] ${oldLogin} -> ${newLogin} (${userId}): ${e.message}`);
    return null;
  }
}

class DryRun extends Error {}
/**
 * The one-off for a relink the site never recorded: `oldLogin` was `userId`'s login, now it has another (or none).
 * apply=false -> the exact site changes, rolled back. apply=true -> a DB backup, then the login_changes row (Pepe re-keys
 * his records from it) + the site re-key, one transaction. Refused when oldLogin is that account's login today.
 */
async function relink(oldLogin, userId, { apply = false, via = "admin:relink" } = {}) {
  await ensure();
  const u = (await getQuery("SELECT userId, username, camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  if (!u) return { ok: false, error: `no account ${userId}` };
  const old = low(oldLogin);
  if (!old) return { ok: false, error: "no old login" };
  if (low(u.camfrogUsername) === old) return { ok: false, error: `${old} is ${u.username}'s login today - nothing to move` };
  const done = (await getQuery("SELECT id FROM login_changes WHERE userId = ? AND old_key = ?", [u.userId, old]))[0];
  if (done) return { ok: true, already: true, id: done.id, note: `already recorded as change #${done.id}` };
  const newKey = keyOf(u.camfrogUsername, u.userId);
  if (!apply) {
    let log = null;
    try {
      await tx(async () => { log = await rekeySite(old, newKey, null); throw new DryRun("dry run"); });
    } catch (e) { if (!(e instanceof DryRun)) throw e; }
    return { ok: true, dry: true, user: u, from: old, to: newKey, site: log };
  }
  const backup = await require("./dbbackup").backupDb("pre-login-rekey");
  await require("./usernames").recordLogin(u.userId, old, u.camfrogUsername || null, via).catch(() => {});
  const id = await changed(u.userId, old, u.camfrogUsername || null, via);
  const row = (await getQuery("SELECT site_result FROM login_changes WHERE id = ?", [id]))[0];
  return { ok: true, id, user: u, from: old, to: newKey, backup, site: JSON.parse((row && row.site_result) || "[]") };
}

/** POST /api/users/login-changes (bot): {after, limit} -> {ok, changes: [...], last} - Pepe's feed. Read-only. */
async function since(after, limit = 200) {
  await ensure();
  const rows = await getQuery("SELECT id, userId, old_login, new_login, old_key, new_key, at, via FROM login_changes WHERE id > ? ORDER BY id LIMIT ?",
                              [Math.max(0, Math.floor(Number(after) || 0)), Math.min(500, Math.max(1, Math.floor(Number(limit) || 200)))]);
  const last = (await getQuery("SELECT COALESCE(MAX(id), 0) AS m FROM login_changes"))[0].m;
  return { ok: true, changes: rows, last };
}
function register(app, { isBotToken }) {
  ensure().catch((e) => console.error("[login-rekey] setup:", e.message));
  app.post("/api/users/login-changes", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await since(b.after, b.limit)); } catch (e) {
      console.error("[login-rekey] feed:", e.message);
      res.status(500).json({ ok: false, error: "internal server error" });
    }
  });
}

module.exports = { ensure, keyOf, rekeyValue, rekeyJsonText, rekeySite, changed, changedSafe, relink, since, register, NAME_FIELDS };
