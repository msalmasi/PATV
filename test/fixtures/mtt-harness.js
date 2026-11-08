// test/fixtures/mtt-harness.js — the shared set-up of the scheduled-tournament tests (hand-off 22 phase 2, 1.99??): a temporary database, the
// REAL casino service + escrow ledger, a fake clock (svc.S.hooks.now), bot players, a deterministic deck and the PAT conservation oracle.
// Nothing happens when this file is loaded (node --test runs every .js under test/): a test file calls harness(name) first thing.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");

const repo = path.resolve(__dirname, "..", "..");

function harness(name, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  process.chdir(tmp);
  delete process.env.STAGING;
  const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
  const H = require(path.join(repo, "casino", "hmengine"));
  const E = require(path.join(repo, "casino", "bjengine"));
  const svc = require(path.join(repo, "casino", "service"));
  const ESC = require(path.join(repo, "escrow", "ledger"));
  const V = require(path.join(repo, "casino", "veil"));
  const funding = require(path.join(repo, "funding"));
  V._hooks.kind = opts.veil || (async () => null);           // nobody veiled unless a test says so
  const MT = svc.MT;
  const h = { repo, tmp, runQuery, getQuery, H, E, svc, ESC, V, MT, funding };
  h.NOW = Date.UTC(2026, 10, 15, 18, 0, 0);
  svc.S.hooks.now = () => h.NOW;
  let k = 0;
  h.key = () => `${name}-k-${++k}`;
  h.mk = (uid, nm, extra) => Object.assign({ uid, name: nm, username: nm.toLowerCase(), camfrog: null, via: "web", iph: null, admin: false }, extra || {});
  h.players = [];
  h.byUid = {};
  h.admin = h.mk("ad", "Ada");
  h.byUid.ad = h.admin;
  /** a deterministic deck per deal (a seeded shuffle) */
  let deckSeed = 1;
  const rnd = () => { deckSeed = (deckSeed * 1103515245 + 12345) % 2147483648; return deckSeed / 2147483648; };
  h.rng = rnd;
  h.seedDecks = (s) => { deckSeed = s || 1; svc.S.hooks.deck = () => { const d = E.makeShoe(1).slice(); for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; } return d; }; };
  h.later = async (secs) => { h.NOW += secs * 1000; await svc.tickOnce(); };
  h.act = (who, verb, args, o) => { svc.S.rate.clear(); return svc.act(who, verb, args || [], o, h.key()); };
  h.M = (who, verb, args, o) => h.act(who, verb, args, Object.assign({ game: "mtt", room: null }, o || {}));
  h.A = (who, verb, tid, args) => h.act(who, verb, args || [], { game: "holdem", table: tid });
  h.bal = async (uid) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [uid]))[0].b;
  h.house = async () => (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t;
  h.held = async () => (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM escrow_holds WHERE state = 'held'"))[0].t;
  h.wallets = async () => (await getQuery("SELECT COALESCE(SUM(points_balance),0) AS t FROM users"))[0].t;
  h.incentives = async () => { try { return (await getQuery("SELECT COALESCE(SUM(balance),0) AS t FROM pools WHERE key = 'incentives'"))[0].t; } catch (e) { return 0; } };
  /** the conservation oracle: wallets + held + House + incentives */
  h.total = async () => (await h.wallets()) + (await h.held()) + (await h.house()) + (await h.incentives());

  h.setup = async (n) => {
    await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                    points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT,
                    createdAt TEXT, email TEXT, discordId TEXT, twitchId TEXT, auto_source TEXT)`);
    await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)`);
    await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await runQuery("CREATE TABLE user_roles (userId TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (userId, role))");
    await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
    for (let i = 1; i <= n; i++) {
      const p = h.mk("u" + i, "P" + String(i).padStart(3, "0"));
      h.players.push(p);
      h.byUid[p.uid] = p;
      await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance, level, createdAt) VALUES (?, ?, ?, 'x', 1000000, 10, '2026-01-01 00:00:00')",
                     [p.uid, p.username, p.name]);
    }
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername) VALUES ('ad', 'ada', 'Ada', 'x', 'Admin', 1000000, 'AdaCF')");
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES ('st', 'sam', 'Sam', 'x', 'Staff', 1000000)");
    h.staff = h.mk("st", "Sam");
    h.byUid.st = h.staff;
    await funding.init();
    await ESC.init();
  };
  h.fresh = async (o = {}) => {
    h.NOW += 60e3;                                       // (a fresh start never falls inside the last test's 2 s op gap)
    svc.stop();
    svc.S.hooks.crash = null;
    svc.S.rate.clear();
    h.seedDecks(o.deckSeed || 7);
    for (const t of ["casino_tables", "casino_events", "casino_rounds", "casino_actions", "transactions", "reserve_claims", "casino_settings", "escrow_holds", "escrow_moves",
                     "escrow_meta", "admin_audit", "casino_mtt", "casino_mtt_entries", "casino_mtt_points", "casino_mtt_watch", "casino_mtt_reminders", "casino_mtt_log",
                     "inbox", "casino_ach_counts", "casino_reward_done"]) {
      await runQuery(`DELETE FROM ${t}`).catch(() => {});
    }
    await runQuery("UPDATE users SET points_balance = 1000000, casino_banned = 0");
    await runQuery("DELETE FROM jackpot_rakes");
    await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('seed', 'seed', 10000000)");
    await runQuery("DELETE FROM user_roles");
    await runQuery("DELETE FROM welcome_bonus");
    await ESC.init();
    if (o.live !== false) await runQuery("INSERT OR REPLACE INTO escrow_meta (key, value) VALUES ('live', 'true')");
    ESC._forgetLive();
    funding.sync({});
    await svc.boot({ tick: false });
    await svc.setSetting("hm_enabled", "1", "test");
    if (o.mtt !== null) await svc.setSetting("casino_mtt", o.mtt || "everyone", "test");
    await svc.setSetting("mtt_presence", o.presence || "off", "test");
    for (const [k2, v] of Object.entries(o.settings || {})) await svc.setSetting(k2, String(v), "test");
    await svc.loadSettings(true);
  };
  /** schedule one as the admin: -> M (registration opened if `open`) */
  h.schedule = async (form, o = {}) => {
    const start = h.NOW + (o.startIn || 60) * 60e3;
    const body = Object.assign({ title: "Sunday Stack", start_at: start, reg_opens_at: h.NOW, buyin: 1000, structure: "standard", table_size: 9, max_entries: 180, min_entries: 2 }, form || {});
    const r = await svc.locked(() => MT.admin("create", h.admin, null, body));
    assert.ok(r.ok, JSON.stringify(r));
    const M = svc.S.mtts.get(r.ids[0]);
    if (o.open !== false) { await h.later(1); assert.equal(M.status, "registering", "registration opened"); }
    return M;
  };
  h.reg = async (M, list, o) => {
    for (const p of list) {
      const r = await h.M(p, "join", [String(M.no)].concat(o && o.remind ? ["remind"] : []));
      assert.ok(r.ok, `${p.uid}: ${r.reply}`);
      h.NOW += 2100;                                         // (one MTT op per user per 2 s)
    }
  };
  /** to the start (and a tick) */
  h.toStart = async (M) => { h.NOW = Math.max(h.NOW, M.start_at); await svc.tickOnce(); };
  /** a policy: one aggressor per hand (all-in with probability q), at most one caller, everyone else folds / checks */
  h.policy = (q = 0.35, callP = 0.8) => (T, a) => {
    const e = T.eng;
    const allin = e.players.filter((k2) => e.allin.includes(k2));
    const shove = (e.street_paid[a] || 0) + (e.chips[a] || 0) > e.current_bet ? "allin" : "call";
    if (!allin.length && e.current_bet <= e.bb) return h.rng() < q ? shove : H.toCall(e, a) ? "fold" : "check";
    if (allin.length && !T.__caller) { if (h.rng() < callP) { T.__caller = a; return "call"; } }
    return H.toCall(e, a) ? "fold" : "check";
  };
  h.allIn = () => (T, a) => { const e = T.eng; return (e.street_paid[a] || 0) + (e.chips[a] || 0) > e.current_bet ? "allin" : "call"; };
  /** play every MTT table until `until(M)`; `each(M)` runs after every hand end / boundary pass (chip conservation etc.) */
  h.drive = async (M, { policy, until, max = 200000, each = null, step = 1 } = {}) => {
    policy = policy || h.policy();
    const hands = new Map();
    for (let i = 0; i < max; i++) {
      const m = svc.S.mtts.get(M.id) || M;
      if (until ? until(m) : !["running", "finishing"].includes(m.status)) return i;
      let acted = false;
      for (const T of MT.liveTables(m)) {
        if (!T.eng.hand_active) continue;
        if (hands.get(T.id) !== T.eng.hand_no) { hands.set(T.id, T.eng.hand_no); T.__caller = null; }
        const a = H.currentActor(T.eng);
        if (!a || !T.turn || T.turn.uid !== a) continue;
        const verb = policy(T, a) || "fold";
        const r = await h.A(h.byUid[a], verb, T.id);
        assert.ok(r.ok, `${a} ${verb}: ${r.reply}`);
        acted = true;
        if (each) await each(m);
      }
      if (!acted) { h.NOW += step * 1000; await svc.tickOnce(); if (each) await each(m); }
    }
    throw new Error("drive: the tournament didn't get there");
  };
  /** chip conservation at this moment (between steps) */
  h.chipsOk = (M) => { const m = svc.S.mtts.get(M.id) || M; if (m.status !== "running") return; assert.equal(MT.chipsInPlay(m), m.total_chips, "chips in play = total chips"); };
  h.entries = (M, where, args) => getQuery(`SELECT * FROM casino_mtt_entries WHERE tid = ?${where ? " AND " + where : ""} ORDER BY created, user_id, gen`, [M.id].concat(args || []));
  /** every TNY hold of M ended exactly once (spent by the one settle, or refunded) */
  h.holdsEnded = async (M) => {
    const holds = await getQuery("SELECT * FROM escrow_holds WHERE ref = ?", [`TNY-${M.id}`]);
    for (const x of holds) assert.ok(["spent", "refunded"].includes(x.state), `hold ${x.id} ${x.state}`);
    const fin = (await getQuery("SELECT COUNT(*) AS n FROM escrow_moves WHERE key = ?", [`tny:${M.id}:finish`]))[0].n;
    assert.ok(fin <= 1);
    return holds;
  };
  h.restart = async () => { svc.stop(); await svc.boot({ tick: false }); return svc.S.mtts; };
  return h;
}

module.exports = { harness };
