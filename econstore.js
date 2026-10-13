// econstore.js — 1.99ns Phase 1: the economy's settings and journals live on the site next to the pools (pools.js).
//
// Pepe still RUNS the policy (the Monday epoch, the daily monetary tick, Fed mints / grants / loans, room vaults, the
// launchpad - Phase 4 moves those engines). What moves now is where their state is kept and edited:
//
//   econ_docs         name PK (econ_layers | econ_monetary | econ_treasury | econ_launchpad | econ_rooms | vault_marks |
//                     route_keys | stake_drained), doc (JSON), rev, updated. Pepe pushes every change (ordered, rev-checked:
//                     an older rev never overwrites a newer one); his own copy stays the truth until Phase 4 (he reads one back only if he lost it) while his pools are on
//                     the site. A local-only Pepe keeps them in turf_data.json, as before.
//   fed_journal       id PK ("mint:<key>", "grant:<key>", "loan:<id>"), kind, amount, pool, policy, reason, actor, state, ts,
//                     data - one row per Fed mint / grant / loan, derived from econ_layers on every push (the v2 genesis and
//                     /admin/economy read it; nothing writes it by hand)
//   incentive_groups  grp PK, week, budget, spent, remaining, updated - this week's incentive budget groups (econ_treasury)
//   pat_routes        flow PK, shares (JSON [[dest, pct], ...]), updated, by   the PAT Routing table's overrides
//   pat_routes_log    every change (ts, by, via, flow, old, new)
//   econ_cfg          key PK, value (JSON), updated, by                        the econ_cfg settings an admin changed
//   econ_cfg_log      every change (ts, by, via, key, old, new) - Pepe's econ_cfg_log carried over at the cutover
//   econ_catalog      id = 1: Pepe's routing catalog (flows, labels, defaults, limits, destinations) + the econ_cfg spec,
//                     so /admin/economy can render and pre-check the forms
//
// Edits from /admin/economy (routing, econ_cfg, Fed mint / fund / fedloan / flash) are website actions Pepe runs with his
// own validation (kinds econ.routes / econ.cmd, pepe_webact.py) - one rule set, the chat commands keep working - and his
// answer carries the new authoritative table, saved here (/api/econ/settings/put). Pepe down: the request waits (TTL).
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const DOCS = ["econ_layers", "econ_monetary", "econ_treasury", "econ_launchpad", "econ_rooms", "vault_marks", "route_keys", "stake_drained"];
const MAX_DOC = 4 * 1024 * 1024;
const LOG_KEEP = 2000;

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS econ_docs (name TEXT PRIMARY KEY, doc TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, updated INTEGER)");
      await runQuery(`CREATE TABLE IF NOT EXISTS fed_journal (id TEXT PRIMARY KEY, kind TEXT NOT NULL, amount INTEGER, pool TEXT, policy TEXT,
        reason TEXT, actor TEXT, state TEXT, ts REAL, data TEXT, updated INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS fed_journal_ts ON fed_journal (ts)");
      await runQuery(`CREATE TABLE IF NOT EXISTS incentive_groups (grp TEXT PRIMARY KEY, week TEXT, budget INTEGER, spent INTEGER, remaining INTEGER,
        updated INTEGER)`);
      await runQuery("CREATE TABLE IF NOT EXISTS pat_routes (flow TEXT PRIMARY KEY, shares TEXT NOT NULL, updated INTEGER, by TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS pat_routes_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, by TEXT, via TEXT, flow TEXT,
        old TEXT, new TEXT)`);
      await runQuery("CREATE TABLE IF NOT EXISTS econ_cfg (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER, by TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS econ_cfg_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, by TEXT, via TEXT, key TEXT,
        old TEXT, new TEXT)`);
      await runQuery("CREATE TABLE IF NOT EXISTS econ_catalog (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated INTEGER)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const J = (v) => JSON.stringify(v === undefined ? null : v);
const parse = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };
const str = (v, n) => (v === undefined || v === null ? null : String(v).slice(0, n));
const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);

// ── derived tables ──
async function deriveFedJournal(layers) {
  const L = layers && typeof layers === "object" ? layers : {};
  const t = Date.now();
  const put = (id, kind, r) => runQuery(`INSERT INTO fed_journal (id, kind, amount, pool, policy, reason, actor, state, ts, data, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, pool = excluded.pool,
      policy = excluded.policy, reason = excluded.reason, actor = excluded.actor, state = excluded.state, ts = excluded.ts,
      data = excluded.data, updated = excluded.updated`,
    [id.slice(0, 160), kind, num(r.amount != null ? r.amount : r.principal), str(r.dest || r.vault || r.pool, 80), str(r.policy || r.source, 40),
     str(r.reason, 300), str(r.actor, 60), str(r.state, 20), Number(r.ts) || null, J(r).slice(0, 20000), t]);
  let n = 0;
  for (const [k, r] of Object.entries(L.fed_mints || {})) { if (r && typeof r === "object") { await put("mint:" + k, "mint", r); n++; } }
  for (const [k, r] of Object.entries(L.fed_grants || {})) { if (r && typeof r === "object") { await put("grant:" + k, "grant", r); n++; } }
  for (const [k, r] of Object.entries(L.fed_loans || {})) { if (r && typeof r === "object") { await put("loan:" + k, "loan", r); n++; } }
  return n;
}
async function deriveIncentiveGroups(treasury) {
  const w = treasury && treasury.week && typeof treasury.week === "object" ? treasury.week : null;
  if (!w) return 0;
  const t = Date.now();
  let n = 0;
  const budgets = w.budgets || {}, spent = w.spent || {};
  for (const g of new Set([...Object.keys(budgets), ...Object.keys(spent)])) {
    const b = num(budgets[g]) || 0, s = num(spent[g]) || 0;
    await runQuery(`INSERT INTO incentive_groups (grp, week, budget, spent, remaining, updated) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(grp) DO UPDATE SET week = excluded.week, budget = excluded.budget, spent = excluded.spent,
                    remaining = excluded.remaining, updated = excluded.updated`, [String(g).slice(0, 32), str(w.id, 20), b, s, b < 0 ? null : Math.max(0, b - s), t]);   // 1.99sr: budget -1 = uncapped
    n++;
  }
  return n;
}

// ── docs ──
async function putDocs(docs, { force = false } = {}) {
  await init();
  const out = {};
  for (const [name, x] of Object.entries(docs && typeof docs === "object" ? docs : {})) {
    if (!DOCS.includes(name) || !x || typeof x !== "object") continue;
    const text = J(x.doc);
    if (text.length > MAX_DOC) { out[name] = { ok: false, error: "too big" }; continue; }
    const rev = num(x.rev) || 0;
    const cur = (await getQuery("SELECT rev FROM econ_docs WHERE name = ?", [name]))[0];
    if (cur && !force && Number(cur.rev) > rev) { out[name] = { ok: false, stale: true, rev: Number(cur.rev) }; continue; }
    await runQuery(`INSERT INTO econ_docs (name, doc, rev, updated) VALUES (?, ?, ?, ?)
                    ON CONFLICT(name) DO UPDATE SET doc = excluded.doc, rev = excluded.rev, updated = excluded.updated`, [name, text, rev, Date.now()]);
    // P4-1: once the Fed's books live on the site, fed/service.js writes fed_journal with every record - Pepe's pushed
    // econ_layers is then his read-only mirror of them and never overwrites the journal
    if (name === "econ_layers" && !(await require("./fed/service").live().catch(() => false))) await deriveFedJournal(x.doc);
    if (name === "econ_treasury") await deriveIncentiveGroups(x.doc);
    out[name] = { ok: true, rev };
  }
  return out;
}
async function getDocs() {
  await init();
  const out = {};
  for (const r of await getQuery("SELECT name, doc, rev, updated FROM econ_docs")) out[r.name] = { doc: parse(r.doc, null), rev: Number(r.rev) || 0, updated: r.updated };
  return out;
}

// ── settings (routing overrides, econ_cfg) ──
function cleanRoutes(x) {
  const out = {};
  for (const [flow, shares] of Object.entries(x && typeof x === "object" ? x : {})) {
    if (!/^[A-Za-z0-9_:.-]{1,64}$/.test(flow) || !Array.isArray(shares)) continue;
    out[flow] = shares.slice(0, 6).map((s) => [String((s || [])[0] || "").slice(0, 80), Number((s || [])[1]) || 0]);
  }
  return out;
}
/**
 * Pepe's authoritative routing overrides + econ_cfg (after any change, and at start). Diffs into the tables, one log row
 * per changed flow / key. -> {routes_changed, cfg_changed}
 */
async function putSettings(b) {
  await init();
  const by = str(b.actor, 60) || "pepe", via = str(b.via, 20) || "pepe";
  const t = Date.now();
  let rc = 0, cc = 0;
  if (b.pat_routes && typeof b.pat_routes === "object") {
    const want = cleanRoutes(b.pat_routes);
    const have = {};
    for (const r of await getQuery("SELECT flow, shares FROM pat_routes")) have[r.flow] = r.shares;
    for (const [flow, shares] of Object.entries(want)) {
      const s = J(shares);
      if (have[flow] === s) continue;
      await runQuery(`INSERT INTO pat_routes (flow, shares, updated, by) VALUES (?, ?, ?, ?)
                      ON CONFLICT(flow) DO UPDATE SET shares = excluded.shares, updated = excluded.updated, by = excluded.by`, [flow, s, t, by]);
      await runQuery("INSERT INTO pat_routes_log (ts, by, via, flow, old, new) VALUES (?, ?, ?, ?, ?, ?)", [t, by, via, flow, have[flow] || null, s]);
      rc++;
    }
    for (const flow of Object.keys(have)) {
      if (flow in want) continue;
      await runQuery("DELETE FROM pat_routes WHERE flow = ?", [flow]);
      await runQuery("INSERT INTO pat_routes_log (ts, by, via, flow, old, new) VALUES (?, ?, ?, ?, ?, ?)", [t, by, via, flow, have[flow], null]);
      rc++;
    }
  }
  if (b.econ_cfg && typeof b.econ_cfg === "object") {
    const have = {};
    for (const r of await getQuery("SELECT key, value FROM econ_cfg")) have[r.key] = r.value;
    for (const [k, v] of Object.entries(b.econ_cfg)) {
      if (!/^[a-z0-9_]{1,64}$/.test(k)) continue;
      const s = J(v);
      if (have[k] === s) continue;
      await runQuery(`INSERT INTO econ_cfg (key, value, updated, by) VALUES (?, ?, ?, ?)
                      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by`, [k, s, t, by]);
      cc++;
    }
    for (const k of Object.keys(have)) if (!(k in b.econ_cfg)) { await runQuery("DELETE FROM econ_cfg WHERE key = ?", [k]); cc++; }
  }
  // Pepe's own econ_cfg_log (who changed what, in chat or on his panel): rows newer than the newest one kept here
  if (Array.isArray(b.econ_cfg_log)) {
    const last = Number(((await getQuery("SELECT MAX(ts) AS m FROM econ_cfg_log"))[0] || {}).m) || 0;
    for (const e of b.econ_cfg_log.slice(-500)) {
      const ts = Math.trunc(Number(e && e.ts) * (Number(e && e.ts) < 1e12 ? 1000 : 1)) || 0;
      if (!ts || ts <= last || !e.key) continue;
      await runQuery("INSERT INTO econ_cfg_log (ts, by, via, key, old, new) VALUES (?, ?, ?, ?, ?, ?)",
                     [ts, str(e.by, 60), str(e.via, 20), str(e.key, 64), J(e.old), J(e.new)]);
    }
    await runQuery(`DELETE FROM econ_cfg_log WHERE id NOT IN (SELECT id FROM econ_cfg_log ORDER BY id DESC LIMIT ${LOG_KEEP})`);
  }
  if (b.catalog && typeof b.catalog === "object") {
    const s = J(b.catalog);
    if (s.length < MAX_DOC) await runQuery("INSERT INTO econ_catalog (id, data, updated) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated", [s, t]);
  }
  return { routes_changed: rc, cfg_changed: cc };
}
async function getSettings() {
  await init();
  const pat_routes = {}, econ_cfg = {};
  for (const r of await getQuery("SELECT flow, shares FROM pat_routes")) pat_routes[r.flow] = parse(r.shares, []);
  for (const r of await getQuery("SELECT key, value FROM econ_cfg")) econ_cfg[r.key] = parse(r.value, null);
  return { pat_routes, econ_cfg };
}

/** The cutover (pools.importFromPepe, inside its transaction): the docs, routes and settings from Pepe's export. */
async function importInTx(p, { key } = {}) {
  await init();
  const docs = {};
  for (const n of DOCS) if (p.docs && p.docs[n] !== undefined) docs[n] = { doc: p.docs[n], rev: num(p.docs_rev) || 1 };
  const d = await putDocs(docs, { force: true });
  const s = await putSettings({ pat_routes: p.routes || {}, econ_cfg: p.econ_cfg || {}, econ_cfg_log: p.econ_cfg_log || [],
                                catalog: p.catalog || null, actor: "cutover " + (key || ""), via: "import" });
  const fj = (await getQuery("SELECT COUNT(*) AS n FROM fed_journal"))[0].n;
  return { docs: Object.keys(d).filter((k) => d[k].ok).length, routes: Object.keys(p.routes || {}).length,
           econ_cfg: Object.keys(p.econ_cfg || {}).length, fed_journal: Number(fj) || 0, ...s };
}

/** Everything this module holds, for an export / the way back. */
async function exportAll() {
  await init();
  const s = await getSettings();
  return { ok: true, docs: await getDocs(), ...s,
           fed_journal: await getQuery("SELECT id, kind, amount, pool, policy, reason, actor, state, ts FROM fed_journal ORDER BY ts"),
           incentive_groups: await getQuery("SELECT * FROM incentive_groups ORDER BY grp"),
           routes_log: await getQuery("SELECT * FROM pat_routes_log ORDER BY id DESC LIMIT 200"),
           econ_cfg_log: await getQuery("SELECT * FROM econ_cfg_log ORDER BY id DESC LIMIT 200"),
           catalog: parse(((await getQuery("SELECT data FROM econ_catalog WHERE id = 1"))[0] || {}).data, null) };
}

async function adminView() {
  const all = await exportAll();
  const docs = {};
  for (const [k, v] of Object.entries(all.docs)) docs[k] = { rev: v.rev, updated: v.updated, size: J(v.doc).length };
  return { docs, pat_routes: all.pat_routes, econ_cfg: all.econ_cfg, fed_journal: all.fed_journal.slice(-50).reverse(),
           incentive_groups: all.incentive_groups, routes_log: all.routes_log.slice(0, 40), econ_cfg_log: all.econ_cfg_log.slice(0, 40),
           catalog: all.catalog };
}

// ── /admin/economy edits: website actions Pepe runs (econ.routes / econ.cmd) with a password step-up ──
// 2026-10-12: + activitypads / profilevaults (the 🎁 Activity -> pad vaults card)
const ECON_CMDS = new Set(["get", "set", "mint", "fund", "grant", "fedloan", "flash", "fedseed", "monetary", "mints", "check", "status",
                           "activitypads", "profilevaults"]);
async function requestEdit(user, body, ip) {
  const ctl = require("./pepecontrol");
  const bcrypt = require("bcrypt");
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (!user || user.class !== "Admin") throw fail(403, "Admins only.");
  if (!ctl.takeNonce(user, body.nonce)) throw fail(409, "That confirmation was already used or has expired - start again.");
  const row = (await getQuery("SELECT password FROM users WHERE userId = ?", [user.userId]))[0];
  const hash = row && typeof row.password === "string" && row.password.startsWith("$2") ? row.password : null;
  if (!hash) throw fail(403, "Your account has no password to confirm with - set one (forgot password) first.");
  if (typeof body.password !== "string" || !body.password || Buffer.byteLength(body.password, "utf8") > 200 || !(await bcrypt.compare(body.password, hash))) {
    throw fail(403, "Wrong password.");
  }
  let kind, args, label;
  if (body.op === "routes") {
    const flow = String(body.flow || "");
    if (!/^[A-Za-z0-9_:.-]{1,64}$/.test(flow)) throw fail(400, "Pick a flow.");
    const shares = body.reset ? null : cleanRoutes({ [flow]: body.shares })[flow];
    kind = "econ.routes";
    args = [flow, shares === null ? "default" : JSON.stringify(shares)];
    label = `Routing ${flow} -> ${shares === null ? "default" : shares.map((s) => s[0] + " " + s[1] + "%").join(", ")}`;
  } else if (body.op === "cmd") {
    const words = String(body.text || "").trim().replace(/^!?econ\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 40).map((w) => w.slice(0, 120));
    if (!words.length || !ECON_CMDS.has(words[0].toLowerCase())) throw fail(400, "Only !econ get|set|mint|fund|fedloan|flash|fedseed|monetary|mints|check|activitypads|profilevaults from here.");
    kind = "econ.cmd";
    args = words;
    label = "!econ " + words.join(" ");
  } else {
    throw fail(400, "Unknown edit.");
  }
  const id = await require("./actions").queue(user.userId, { kind, args, tag: "econ-admin", label: label.slice(0, 200) });
  console.log(`[econstore] ${user.username} queued ${kind} (${label.slice(0, 120)}) as action ${id} (ip ${ctl.ipHash(ip)})`);
  return { id };
}

function register(app, { isBotToken, addUser }) {
  init().catch((e) => console.error("[econstore] init:", e.message));
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) { console.error("[econstore] bot:", e); res.status(500).json({ ok: false, error: "server_error" }); }
  };
  // 2026-10-12: Pepe's econ docs (econ_rooms ~57 KB + econ_treasury ~38 KB + ...) passed index.js' global 100 KB JSON limit on
  // prod - every push since the pools cutover answered 413 (PayloadTooLargeError) and the site kept the cutover's copy. The
  // route parses its own body (8 docs x MAX_DOC) and index.js skips it.
  app.post("/api/econ/docs/put", require("express").json({ limit: "32mb" }), bot(async (b) => ({ ok: true, docs: await putDocs(b.docs) })));
  app.post("/api/econ/docs/get", bot(async () => ({ ok: true, docs: await getDocs() })));
  app.post("/api/econ/settings/put", bot(async (b) => Object.assign({ ok: true }, await putSettings(b))));
  app.post("/api/econ/settings/get", bot(async () => Object.assign({ ok: true }, await getSettings())));
  app.post("/api/econ/export", bot(() => exportAll()));

  const ctl = require("./pepecontrol");
  const admin = (req, res, next) => {
    if (!req.user || !req.user.userId) return res.status(401).json({ error: "Sign in first." });
    if (req.user.class !== "Admin") return res.status(403).json({ error: "Admins only." });
    next();
  };
  const csrf = (req, res, next) => {
    if (!require("./middleware/authGuard").sameSite(req) || !ctl.csrfOk(req.user.username, req.get("x-csrf-token"))) {
      return res.status(403).json({ error: "Security check failed - reload the page." });
    }
    next();
  };
  const noStore = (req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
  app.get("/api/admin/econ/store", noStore, addUser, admin, async (req, res) => {
    try {
      const pools = await require("./pools").adminView();
      res.json(Object.assign({ pools }, await adminView()));
    } catch (e) { console.error("[econstore] view:", e); res.status(500).json({ error: "failed" }); }
  });
  app.post("/api/admin/econ/edit/nonce", noStore, addUser, admin, csrf, (req, res) => res.json({ nonce: ctl.issueNonce(req.user) }));
  app.post("/api/admin/econ/edit", noStore, addUser, admin, csrf, async (req, res) => {
    try { res.json({ ok: true, request: await requestEdit(req.user, req.body || {}, req.ip) }); }
    catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong." }); }
  });
  app.get("/api/admin/econ/edit/:id", noStore, addUser, admin, async (req, res) => {
    const r = (await getQuery("SELECT id, kind, status, message, label, created, updated FROM pepe_actions WHERE id = ? AND kind IN ('econ.routes','econ.cmd')",
      [parseInt(req.params.id, 10) || 0]))[0];
    if (!r) return res.status(404).json({ error: "No such request." });
    res.json({ action: r });
  });
}

module.exports = { init, register, putDocs, getDocs, putSettings, getSettings, importInTx, exportAll, adminView, requestEdit, DOCS };
