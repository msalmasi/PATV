// Roulette tables share the casino mutex, ledger, veil and clock with the card tables.
"use strict";
const crypto = require("crypto");
const fair = require("./fair");
const money = require("./money");
const engine = require("./rlengine");
const grammar = require("./rlbets");
const store = require("./rlstore");
const V = require("./veil");
const { runQuery, getQuery, tx } = require("../dbUtils");
const perms = require("../siteperms");

const AUDIENCES = ["off", "staff", "everyone"];
const DEFAULTS = {
  casino_roulette: "off",
  rl_min_bet: 100,
  rl_max_straight: 5000,
  rl_max_split: 10000,
  rl_max_street: 15000,
  rl_max_corner: 20000,
  rl_max_line: 30000,
  rl_max_outside: 50000,
  rl_max_spin: 100000,
  rl_max_positions: 30,
  rl_max_lines: 20,
  rl_max_players: 30,
  rl_bank_pct: 10,
  rl_spin_cap: 2000000,
  rl_bet_secs: 25,
  rl_spin_secs: 12, // 1.99aoj (D6): 8 -> 12 s, so the ball drop (casino/rlwheel.js) reads as real (bounds 4-20 kept)
  rl_result_secs: 5,
  rl_idle_close_mins: 10,
  // 1.99aoj (D2): the 💎 High Roller wheels' limits (a wheel opened with !rl start hr / the web's High Roller card) - the same
  // shapes as the rl_* ones above, and rl_hr_spin_cap, the High Roller wheels' share of the ONE House budget (available())
  rl_hr_min_bet: 1000,
  rl_hr_max_straight: 25000,
  rl_hr_max_split: 50000,
  rl_hr_max_street: 75000,
  rl_hr_max_corner: 100000,
  rl_hr_max_line: 150000,
  rl_hr_max_outside: 250000,
  rl_hr_max_spin: 500000,
  rl_hr_spin_cap: 1000000,
};
const SETTING_KEYS = Object.keys(DEFAULTS);
const POSITIONS = ["straight", "split", "street", "corner", "line", "outside"];
const caps = POSITIONS.map((k) => "rl_max_" + k);
const hrCaps = POSITIONS.map((k) => "rl_hr_max_" + k);
const bounds = {
  rl_max_positions: [1, 60],
  rl_max_lines: [1, 60],
  rl_max_players: [1, 35],
  rl_bank_pct: [1, 20],
  rl_spin_cap: [0, 10000000],
  rl_bet_secs: [10, 120],
  rl_spin_secs: [4, 20],
  rl_result_secs: [2, 30],
  rl_idle_close_mins: [2, 120],
  rl_hr_spin_cap: [0, 10000000],
};
function valueOf(key, val) {
  if (key === "casino_roulette" && AUDIENCES.includes(val)) return val;
  if (key !== "casino_roulette" && SETTING_KEYS.includes(key) && /^\d+$/.test(String(val))) {
    const [min, max] = bounds[key] || [1, 1e10];
    if (Number(val) >= min && Number(val) <= max) return Number(val);
  }
  throw Error("Invalid roulette setting: " + key);
}
function ordered(s) {
  return caps.every((k) => s[k] >= s.rl_min_bet && s[k] <= s.rl_max_spin);
}
// 1.99aoj (D2): the High Roller set - each cap between its minimum and its per-spin maximum, and a straight's worst case (35 to 1)
// inside the High Roller House cap, or not even one straight at the cap could ever be admitted
function orderedHr(s) {
  return (
    hrCaps.every((k) => s[k] >= s.rl_hr_min_bet && s[k] <= s.rl_hr_max_spin) && s.rl_hr_max_straight * 35 <= s.rl_hr_spin_cap
  );
}
function checkSetting(key, val, current = DEFAULTS) {
  const value = valueOf(key, val),
    next = { ...DEFAULTS, ...current, [key]: value };
  if (!ordered(next)) throw Error("Position limits must be between the minimum bet and the spin maximum.");
  if (!orderedHr(next))
    throw Error(
      "High Roller position limits must be between the High Roller minimum bet and its spin maximum, and 35 times the straight limit must fit in the High Roller House cap.",
    );
  return String(value);
}
function readSettings(kv) {
  const s = { ...DEFAULTS };
  for (const k of SETTING_KEYS) {
    if (kv[k] !== undefined)
      try {
        s[k] = valueOf(k, kv[k]);
      } catch (_) {
        /* invalid stored value uses default */
      }
  }
  if (!ordered(s)) for (const k of [...caps, "rl_min_bet", "rl_max_spin"]) s[k] = DEFAULTS[k];
  if (!orderedHr(s)) for (const k of [...hrCaps, "rl_hr_min_bet", "rl_hr_max_spin", "rl_hr_spin_cap"]) s[k] = DEFAULTS[k];
  return s;
}
// 1.99aoj (D3): a wheel's limits - its tier's settings (normal, or 💎 High Roller) - as one object. Snapshotted into T.lim when each
// spin opens (nextSeed), so an admin's edit never changes the limits inside a betting window; every check, the views, the limits
// verb and the push / advert lines read it (lim(T) in install()).
function tierLimits(s, high) {
  const p = high ? "rl_hr_" : "rl_";
  return {
    tier: high ? "hr" : "main",
    min: s[p + "min_bet"],
    caps: Object.fromEntries(POSITIONS.map((k) => [k, s[p + "max_" + k]])),
    max_spin: s[p + "max_spin"],
    max_positions: s.rl_max_positions,
    max_actions: s.rl_max_lines,
    max_players: s.rl_max_players,
  };
}
// which cap a position kind uses (the rules' `kinds`: trio -> street, first four -> corner, the rest of the outside bets -> outside)
const KINDS = {
  trio: "street",
  first_four: "corner",
  dozen: "outside",
  column: "outside",
  red: "outside",
  black: "outside",
  odd: "outside",
  even: "outside",
  low: "outside",
  high: "outside",
};
const capKind = (kind) => KINDS[kind] || (POSITIONS.includes(kind) ? kind : "outside");
const HELP =
  "🛞 Use !rl with a bet and an amount, like red 500, 17 100, or 17-18 100. Try bets, undo, clear, again, limits, last, fair, go or end. !rl go spins a wheel you bet on alone. !rl start opens a wheel in this room (!rl start hr: a 💎 High Roller wheel). !spin is the separate prize wheel.";
const sum = (list) => list.reduce((a, b) => a + b, 0);
const amountOf = (bets) => sum(bets.map((b) => b.amount));
// UI-11: a web reply names dozens, columns and low / high as the felt does; Pepe's (and every text the page parses back -
// meView lines, the queued line, the last slip) keeps the tokens. SUITES-9: amounts read like the totals (1,000).
const LABELS = { d1: "1st dozen", d2: "2nd dozen", d3: "3rd dozen", c1: "column 1", c2: "column 2", c3: "column 3", low: "1–18", high: "19–36" };
const label = (token, web) => (web && LABELS[token]) || token;
const thousands = (n) => Math.trunc(Number(n) || 0).toLocaleString("en-US");
const describe = (bets, web) => bets.map((b) => label(grammar.token(b), web) + " " + thousands(b.amount)).join(" · ");
function pocketText(p) {
  if (p === 0) return "🟢 0 — zero";
  return (
    (engine.color(p) === "red" ? "🔴 " : "⚫ ") +
    p +
    " " +
    engine.color(p) +
    " · " +
    (p % 2 ? "odd" : "even") +
    " · " +
    (p <= 18 ? "low" : "high") +
    " · " +
    ["1st", "2nd", "3rd"][Math.ceil(p / 12) - 1] +
    " dozen · column " +
    (((p - 1) % 3) + 1)
  );
}
function install(core) {
  const {
    S,
    clock,
    save,
    emit,
    fmt,
    link,
    fairLink,
    roomsOf,
    roomList,
    streamGone,
    loadSettings,
    userRow,
    dupOf,
    remember,
    annDue,
    advertCmd,
    advertRepeat,
    cmdStart,
    wake,
  } = core;
  // 1.99aoj: the High Roller role and texts (service.js: blackjack's), a table's adverts, the stream slot's hand-over at a
  // lobby rotation - optional, so an older core (a test's) still installs
  const isHighRoller = core.isHighRoller || (async () => false);
  const advertList = core.advertList || (() => []);
  const streamHandOff = core.streamHandOff || (() => false);
  const viewMoved = core.viewMoved || (() => {});
  const HR_ONLY_PLAY =
    core.HR_ONLY_PLAY ||
    "💎 this is a High Roller table: only High Rollers can play here (the role is in the prize store — !prizes). You can watch.";
  const reply = (ok, message, extra) => ({ ok, reply: message, pm: true, ...extra });
  // 1.99aoj: a refusal with its code and numbers ({text, code, ...}); refuse() makes the reply - the text is the reply as before
  const no = (text, code, extra) => ({ text, code, ...extra });
  const refuse = (x) => {
    if (typeof x === "string") return reply(false, x);
    const { text, ...rest } = x;
    return reply(false, text, rest);
  };
  const open = () => Array.from(S.tables.values()).filter((t) => t.game === "roulette" && t.status === "open");
  const high = (T) => !!(T && T.high_stakes);
  // D3: the wheel's limits for its open spin - T.lim, taken when the spin opened (nextSeed). A wheel with no betting window
  // open (idle, nothing charged) follows the settings as they are now, so an edit reaches a waiting lobby before its first bet.
  function lim(T) {
    if (!T || !T.eng) return tierLimits(S.settings, false);
    const idle = T.eng.phase === "idle" && !(T.eng.book || []).length;
    if (!T.lim || !T.lim.caps || idle) T.lim = tierLimits(S.settings, high(T));
    return T.lim;
  }
  // publicView.limits: the rl_* map the page's placard reads (1.99aoh), with THIS wheel's limits under the normal keys (a High
  // Roller wheel's rl_min_bet is its own minimum) - plus the timers and the bank settings as they are
  function limits(T) {
    const out = Object.fromEntries(
      SETTING_KEYS.filter((k) => k !== "casino_roulette" && !k.startsWith("rl_hr_")).map((k) => [k, S.settings[k]]),
    );
    if (!T) return out;
    const L = lim(T);
    out.rl_min_bet = L.min;
    for (const k of POSITIONS) out["rl_max_" + k] = L.caps[k];
    out.rl_max_spin = L.max_spin;
    out.rl_max_positions = L.max_positions;
    out.rl_max_lines = L.max_actions;
    out.rl_max_players = L.max_players;
    return out;
  }
  const spinKey = (T) => "crl:" + T.id + ":s" + T.eng.round_no;
  let houseRead = null,
    houseAt = null;
  async function shut(actor) {
    const mode = (await loadSettings()).casino_roulette;
    if (mode === "everyone") return null;
    if (mode === "staff" && actor && actor.uid) {
      const u = await userRow(actor.uid);
      if (u && (perms.atLeast(u, "staff") || perms.can(u, "casino.admin"))) return null;
    }
    return mode === "staff" ? "Roulette is open to staff only." : "Roulette is switched off.";
  }
  // UI-10 / SUITES-3: who may see a wheel's view. Switched off, the open spin still lands and pays (decision 2), so a player
  // with PAT on it (a line, a queued line, or their result up) keeps the view - every bet is refused - until it closes.
  // Staff mode stays 404 for everyone its gate refuses (brief G).
  async function viewShut(T, uid) {
    const why = await shut({ uid });
    if (!why || S.settings.casino_roulette !== "off" || !uid || !T || T.game !== "roulette") return why;
    return T.escrowed[uid] || T.eng.pending[uid] || T.eng.net?.[uid] != null ? null : why;
  }
  async function gate(actor) {
    const why = await shut(actor);
    if (why) return why;
    const u = actor && actor.uid && (await userRow(actor.uid));
    return !u ? "Sign in to play." : u.casino_banned ? "You're banned from the casino." : null;
  }
  function crash(step) {
    if (S.hooks.crash === "rl:" + step) throw Error("Interrupted roulette " + step);
  }
  // The live table object takes another state's fields (the object itself stays: S.tables and the callers hold it).
  function adopt(T, saved) {
    for (const key of Object.keys(T)) if (!Object.hasOwn(saved, key)) delete T[key];
    Object.assign(T, saved);
  }
  // ── O2 (ENGINE-8) per-bet storage: casino/rlstore.js holds one row per line; eng.book, T.stakes and T.escrowed are
  // in-memory caches of the open spin's live rows. A transaction edits the live T before its save and, if it throws,
  // restore() reloads the header and the caches (the rows are the source of truth).
  const reconciled = new WeakSet(); // the wheels whose rows this process has reconciled with their JSON (hydrate)
  const settledLines = new WeakMap(); // T -> {round, lines}: the spin that landed, while its result is up (frozenLines)
  let auditedBoot;
  const openRound = (T) => (T.round && T.round.settle !== "done" ? T.round.no : null);
  // FAIR-1: a wheel copied from another database (retireCopy) - never drawn or revealed here
  const copyOf = (T) => !!(T.copied || (T.round && !T.round.seed));
  // Release A (rlstore.js header): JSON.stringify(T) - service.save - writes what the previous build can act on. Before the
  // draw the book goes out as a refund that build runs at its boot (T.stakes + a refund intent marked mirror; a spin
  // nobody has seen drawn is void); from the draw on the full book goes out (it lands the spin as this build would).
  // A copy of T ({...T}: the draw's) carries no toJSON and is written whole - the previous build's own format.
  function mirror() {
    const e = this.eng || {},
      out = { ...this };
    if (!this.intent && (e.phase === "idle" || e.phase === "betting") && Array.isArray(e.book) && e.book.length) {
      const stakes = this.stakes || [];
      out.eng = { ...e, book: [] };
      out.intent = { refund: stakes.map((s) => s.key), amount: sum(stakes.map((s) => s.amount)), why: "restart", mirror: 1 };
    }
    return out;
  }
  function bind(T) {
    if (!Object.hasOwn(T, "toJSON")) Object.defineProperty(T, "toJSON", { value: mirror, configurable: true, writable: true });
    if (!T.eng.slips) T.eng.slips = {};
    if (!T.eng.lastslip) T.eng.lastslip = {};
  }
  function syncStakes(T) {
    T.stakes = T.eng.book.map((l) => ({ key: l.key, uid: l.uid, amount: l.amount }));
    T.escrowed = {};
    for (const l of T.eng.book) T.escrowed[l.uid] = (T.escrowed[l.uid] || 0) + l.amount;
  }
  // the caches from the rows (reads only): the open spin's live lines; the landed spin's lines while its result is up
  async function load(T) {
    bind(T);
    if (T.intent && T.intent.mirror) T.intent = null; // this build's own rollback mirror: only the previous build runs it
    const n = openRound(T);
    T.eng.book = n == null ? [] : await store.live(T.id, n);
    syncStakes(T);
    if (T.eng.phase === "result" && T.round) settledLines.set(T, { round: T.round.no, lines: await store.lines(T.id, T.round.no, "settled") });
    else settledLines.delete(T);
    // while the wheel spins its header is not rewritten for a queued line (saveAnswer): the changes made since the saved
    // header go back on (a queued line, or its clearing; a player the header never saw gets their profile back)
    if (T.eng.phase === "spinning" && T.round)
      for (const q of await store.queued(T.id, T.round.no, T.rev)) {
        if (!q.bets) delete T.eng.pending[q.uid];
        else {
          T.eng.pending[q.uid] = { bets: q.bets };
          if (!T.players[q.uid] && q.profile) T.players[q.uid] = q.profile;
        }
      }
    // a slip an older build saved (full bet objects) becomes the compact one
    for (const [uid, slip] of Object.entries(T.eng.lastslip || {})) if (Array.isArray(slip) && slip.length) T.eng.slips[uid] = packSlip(slip);
    T.eng.lastslip = {};
    T.opno = Math.max(Number(T.opno) || 0, await store.maxOpno(T.id));
  }
  // Once per wheel object (boot loads new ones): the JSON's book gets its rows and the wheel's live rows are checked
  // against the ledger (rlstore.reconcile), then the caches are loaded. A no-op afterwards.
  async function hydrate(T) {
    if (!T || T.game !== "roulette" || T.status !== "open" || reconciled.has(T)) return;
    await store.ensure();
    await auditOnce();
    bind(T);
    const since = store.flags.length;
    await store.reconcile(T, openRound(T), clock());
    await load(T);
    reconciled.add(T);
    report(since);
  }
  // once per boot (the first wheel this process reads, or service boot() after the wheels recover - bootAudit - when no
  // wheel is open: roulette off and every wheel closed after a rollback): the live rows of wheels that are not open
  async function bootAudit() {
    await store.ensure();
    await auditOnce();
  }
  async function auditOnce() {
    if (auditedBoot === S.booted) return;
    auditedBoot = S.booted;
    const since = store.flags.length;
    await store.audit(clock()).catch((e) => console.error("[casino] roulette audit:", e.message));
    report(since);
  }
  // boot: every open wheel's rows before any of them admits a bet (the shared bank sums every wheel's book)
  async function hydrateAll(T) {
    for (const t of open()) if (t !== T) await hydrate(t).catch((e) => console.error("[casino] roulette rows " + t.id + ":", e.message));
    await hydrate(T);
  }
  // an audit finding is an ops alert (once per finding batch; opsalerts is idempotent per ref and rate-limited)
  function report(since) {
    const found = store.flags.slice(since);
    if (!found.length) return;
    const kinds = {};
    for (const f of found) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
    require("../opsalerts")
      .alert({
        source: "casino_rl",
        ref: "audit:" + found[0].key,
        title: "🛞 Roulette audit: " + found.length + " line(s) reconciled",
        body: Object.entries(kinds).map(([k, n]) => k + " x" + n).join(", ") + " - first " + found[0].key,
      })
      .catch((e) => console.error("[casino] roulette audit alert:", e.message));
  }
  async function answer(T, key, uid, out) {
    await runQuery("INSERT OR IGNORE INTO casino_actions (key,table_id,userId,response,created) VALUES (?,?,?,?,?)", [
      key,
      T.id,
      uid,
      JSON.stringify(out),
      clock(),
    ]);
  }
  // A transaction failed after an in-memory edit: the durable header and the caches of the rows come back before the next
  // admission, tick or refund observes that edit.
  async function restore(T) {
    // (review) an event the failed transaction wrote rolled back with it: Pepe's poll cursor is the last committed event
    // again (service.emit advanced it before the commit), so the retry's event - its seq reused - is not skipped
    const m = await getQuery("SELECT MAX(seq) AS s FROM casino_events").catch(() => null);
    if (m) S.lastSeq = (m[0] && m[0].s) || 0;
    if (!T) return;
    const row = (await getQuery("SELECT state FROM casino_tables WHERE id=?", [T.id]))[0];
    if (!row) return;
    adopt(T, JSON.parse(row.state));
    bind(T);
    viewMoved(T); // 1.99aoj (review): its rev went back - a view cached for the rolled-back state is never served again
    if (reconciled.has(T)) await load(T);
  }
  function pruneInactive(T) {
    const e = T.eng;
    e.seats = e.seats.filter((uid) => own(T, uid).length || e.pending[uid] || clock() - e.seen[uid] < 600000);
  }
  // FAIR-3: the spin after a drawn one was committed at the draw (T.next) - a line queued while the wheel spins is accepted
  // after its spin's commitment exists and is shown (publicView next_commitment). A wheel with none commits now.
  async function nextSeed(T) {
    await hydrate(T);
    const n = T.eng.round_no + 1,
      pre = T.next && T.next.no === n && T.next.seed ? T.next : null,
      seed = pre ? pre.seed : fair.newServerSeed();
    await tx(async () => {
      T.round = { seed, commitment: fair.commitment(seed), no: n };
      T.next = null;
      T.eng.round_no = n;
      T.eng.phase = "idle";
      T.eng.book = []; // (O2) a new spin has no live rows yet
      syncStakes(T);
      settledLines.delete(T);
      pruneInactive(T);
      T.eng.actions = {};
      T.dl = {};
      T.lim = tierLimits(S.settings, high(T)); // 1.99aoj (D3): this spin's limits (an admin's edit applies from the next spin)
      if (!pre)
        await runQuery(
          "INSERT INTO casino_rounds (table_id,round_no,commitment,client_seed,num_decks,created) VALUES (?,?,?,?,0,?)",
          [T.id, n, T.round.commitment, T.client_seed, clock()],
        );
      await save(T);
    });
  }
  // 1.99aoj (D1): opts.high = a 💎 High Roller wheel (fixed for its life; the caller checked the role), opts.slot = the house slot a
  // lobby wheel fills ("main"). A wheel opened with room = null and not the lobby is a WEB wheel: its opener hosts it (Host Tools
  // push / advertise / stream / close), it idle-closes like a room wheel, and it is quiet for Pepe until it plays in a room.
  async function start(actor, room, lobby = false, opts = {}) {
    const T = {
      id: crypto.randomBytes(5).toString("hex"),
      game: "roulette",
      status: "open",
      room,
      lobby,
      high_stakes: !!opts.high,
      slot: lobby ? opts.slot || "main" : null,
      web: !lobby && !room,
      host: { uid: actor.uid, name: actor.name },
      created: clock(),
      updated: clock(),
      last_activity: clock(),
      client_seed: fair.newClientSeed(),
      eng: {
        phase: "idle",
        round_no: 0,
        seats: [],
        names: {},
        book: [],
        pending: {},
        lastslip: {},
        history: [],
        seen: {},
        actions: {},
      },
      dl: {},
      players: {},
      escrowed: {},
      stakes: [],
      log: [],
      multi: [],
      rev: 0,
      opno: 0,
      intent: null,
      round: null,
      last_round: null,
      last_revealed: null,
    };
    if (!lobby) V.enter(T, actor);
    await nextSeed(T);
    S.tables.set(T.id, T);
    if (!lobby) {
      const L = lim(T),
        hr = T.high_stakes ? "💎 High Roller " : "";
      await emit(
        T,
        "opened",
        "🛞 " +
          actor.name +
          " opened a " +
          hr +
          "roulette wheel — single zero, straight up pays 35 to 1, bets from " +
          fmt(L.min) +
          " PAT, up to " +
          fmt(L.max_spin) +
          " PAT per player a spin" +
          (T.high_stakes ? " (High Rollers only; anyone can watch)" : "") +
          ". " +
          (room ? "Bet with !rl and a bet and an amount (!rl help), or on the web: " : "Play on the web: ") +
          link(T),
        { high_stakes: !!T.high_stakes },
      );
    }
    return reply(true, "Wheel open.", { table: T.id, pm: false, quiet: true });
  }
  // the open lobby wheel, if there is one (no write, no lock)
  const openLobby = () => (S.settings.casino_roulette === "off" ? null : open().find((t) => t.lobby) || null);
  async function ensureLobby() {
    if (S.settings.casino_roulette === "off") return null;
    let T = open().find((t) => t.lobby);
    if (!T) {
      const r = await start({ uid: "house", name: "Pepe" }, null, true, { slot: "main" });
      T = S.tables.get(r.table);
    }
    return T;
  }
  // 1.99aoj (D2): the bank. ONE House budget for every open wheel: the lesser of rl_spin_cap and rl_bank_pct of the House above
  // its hard floor. A wheel may take a book whose worst pocket fits what the OTHER open wheels' positive worst pockets leave of
  // it; a 💎 High Roller wheel also only what the other High Roller wheels leave of rl_hr_spin_cap - so High Rollers can't starve
  // the normal wheels. Invariant (checked at every admission and removal): sum over all open wheels of max(0, worst) <= budget,
  // and sum over the High Roller wheels <= rl_hr_spin_cap. Pure: the House balance and the books are the caller's.
  const exposure = (t) => (t.eng.book.length ? Math.max(0, engine.worst(engine.lossVector(t.eng.book))) : 0);
  function bankRoom(T, house, wheels) {
    const s = S.settings,
      floor = require("../funding").state.monetary?.house_hard_floor ?? 5000000;
    const budget = Math.min(s.rl_spin_cap, Math.floor(((house - floor) * s.rl_bank_pct) / 100));
    const others = wheels.filter((t) => t !== T);
    let room = budget - sum(others.map(exposure));
    if (high(T)) room = Math.min(room, s.rl_hr_spin_cap - sum(others.filter(high).map(exposure)));
    return { closed: house <= floor, room, budget };
  }
  async function available(T) {
    // (O2) every open wheel's cached book holds its live rows before the shared bank sums them
    for (const t of open()) await hydrate(t);
    if (houseAt === null || houseAt > clock() || houseAt + 5000 <= clock() || T.eng.phase === "idle") {
      houseRead = await money.houseBalance();
      houseAt = clock();
    }
    const { closed, room } = bankRoom(T, houseRead, open());
    return { closed, room };
  }
  // The bank's headroom for one more straight, as the limits verb gives it (decision 10: rounded down to the minimum), capped
  // at the wheel's straight limit
  function bankStraight(T, room) {
    const L = lim(T),
      book = engine.lossVector(T.eng.book);
    const bank = Math.min(...Array.from({ length: 37 }, (_, p) => engine.maxMore(book, engine.positions[p], room)));
    return Math.max(0, Math.min(L.caps.straight, Math.floor(bank / L.min) * L.min));
  }
  // O7: rules.bank_straight for the views - computed here, in an async step that only READS (the House balance; every open
  // wheel's cached book, once each has been read from its rows: else null), at most every 5 s per wheel. Never from the
  // synchronous view, and never through available() (its hydrate can write; the views run without the casino lock). Its own
  // House read: available()'s cache is the bank's, invalidated by each landing.
  const bankCache = new Map(); // table id -> {at, value}
  const BANK_SHOWN_MS = 10000; // (rules: older than this, bank_straight is null)
  let viewHouse = null;
  async function bankRefresh(T) {
    if (!T || T.game !== "roulette" || T.status !== "open") return null;
    const hit = bankCache.get(T.id);
    if (hit && hit.at <= clock() && clock() - hit.at < 5000) return hit.value;
    let value = null;
    try {
      const wheels = open();
      if (wheels.every((t) => reconciled.has(t))) {
        if (!viewHouse || viewHouse.at > clock() || clock() - viewHouse.at >= 5000)
          viewHouse = { at: clock(), v: await money.houseBalance() };
        const b = bankRoom(T, viewHouse.v, open());
        value = b.closed ? 0 : bankStraight(T, b.room);
      }
    } catch (e) {
      value = null;
    }
    bankCache.set(T.id, { at: clock(), value });
    if (bankCache.size > 500) bankCache.delete(bankCache.keys().next().value);
    return value;
  }
  function own(T, uid) {
    return T.eng.book.filter((l) => l.uid === uid);
  }
  // Rebet repeats the player's previous spin as the line's own spin sees it: while a spin is in the air, a rebet is
  // queued for the next spin, so the previous spin is the one on the wheel (lastslip is written only at its landing).
  // (O2) the saved slip is compact - eng.slips[uid] = [[token, amount], ...] - and comes back as bet objects here.
  function lastSlip(T, uid) {
    const lines = own(T, uid);
    if (T.eng.phase === "spinning" && lines.length) return combinedSlip(lines);
    const saved = (T.eng.slips || {})[uid] || (T.eng.lastslip || {})[uid];
    if (!Array.isArray(saved) || !saved.length) return null;
    try {
      return saved.map((b) => (Array.isArray(b) ? store.bet(b) : b));
    } catch (_) {
      return null; // a position this build doesn't know: no rebet
    }
  }
  // where a new wheel opens, as a closing / full wheel's text says it: a room wheel's room types !rl start; a web wheel's host
  // opens one from the casino lobby
  const reopen = (T) =>
    T.web && !roomsOf(T).length ? "a new one opens from the casino lobby" : "!rl start opens a new one";
  // place() asks first, for every line it charges or queues - a bet, a rebet, a line queued while the wheel spins and the queued
  // lines charged when betting opens (queuedLines): 1.99aoj's 💎 High Roller gate (D1; HR_ONLY_PLAY, code E_HR) is here, so
  // it covers all of them; anyone may watch a High Roller wheel
  async function checkSeat(T, actor) {
    const uid = actor.uid,
      e = T.eng;
    if (high(T) && !(await isHighRoller(uid))) return no(HR_ONLY_PLAY, "E_HR");
    if (!e.seats.includes(uid)) {
      if (Object.keys(T.veil || {}).length >= 35 && !(T.veil || {})[uid])
        return T.lobby
          ? "This wheel is full for now — a fresh one opens after this spin."
          : "This wheel is full — it closes after this spin, then " + reopen(T) + ".";
      const mine = await dupOf(uid);
      for (const k of e.seats) {
        const other = await dupOf(k);
        if (k === mine || other === uid || (mine && mine === other))
          return "An account linked to yours already has bets on this wheel.";
      }
    }
    return null;
  }
  function seat(T, a) {
    if (!T.eng.seats.includes(a.uid)) {
      if (a.iph) {
        const other = T.eng.seats.find((k) => T.players[k]?.iph === a.iph);
        if (other) T.multi = T.multi.concat({ ts: clock(), a: a.uid, b: other }).slice(-20);
      }
      T.eng.seats.push(a.uid);
    }
    remember(T, a);
    T.eng.names[a.uid] = T.players[a.uid].name;
    T.eng.seen[a.uid] = clock();
  }
  // the wheel's cap on a position (D3: its spin's limits)
  const capFor = (T, b) => lim(T).caps[capKind(b.kind)] || lim(T).caps.outside;
  // The per-position, position-count and per-spin limits of a line on top of the player's lines (none for a queued
  // line: it opens the player's next spin). -> {why} | {amounts: token -> the player's total on it}. O7: why carries its code
  // and numbers (E_CAP {token, cap, have, min} - have: the player's chips on that spot before this line; E_POS {max};
  // E_SPIN {max, have} - have: the player's total this spin before this line); the reply text is unchanged.
  function lineLimits(T, bets, lines, web) {
    const L = lim(T),
      amounts = new Map();
    for (const b of lines.flatMap((l) => l.bets)) amounts.set(b.token, (amounts.get(b.token) || 0) + b.amount);
    const before = sum([...amounts.values()]);
    for (const b of bets) {
      const had = amounts.get(b.token) || 0,
        amount = had + b.amount,
        cap = capFor(T, b);
      if (!Number.isSafeInteger(b.amount) || b.amount < L.min || amount > cap)
        return {
          why: no("The limit on " + label(b.token, web) + " is " + fmt(cap) + " PAT, minimum " + fmt(L.min) + ".", "E_CAP", {
            token: b.token,
            cap,
            have: had,
            min: L.min,
          }),
        };
      amounts.set(b.token, amount);
    }
    if (amounts.size > L.max_positions) return { why: no("That line exceeds your per-spin limit.", "E_POS", { max: L.max_positions }) };
    if (sum([...amounts.values()]) > L.max_spin)
      return { why: no("That line exceeds your per-spin limit.", "E_SPIN", { max: L.max_spin, have: before }) };
    return { amounts };
  }
  async function checkLine(T, actor, bets) {
    const L = lim(T),
      e = T.eng,
      uid = actor.uid;
    if (!own(T, uid).length && Object.keys(T.escrowed).length >= L.max_players)
      return "The wheel has reached its player limit.";
    if ((e.actions[uid] || 0) >= L.max_actions)
      return no("You've reached the action limit this spin.", "E_ACT", { max: L.max_actions });
    const limited = lineLimits(T, bets, own(T, uid), actor.via === "web");
    if (limited.why) return limited.why;
    const { closed, room } = await available(T);
    if (closed) return no("The wheel's bank is closed right now.", "E_BANK", { more: 0 });
    const next = engine.lossVector(e.book.concat({ uid, bets }));
    if (engine.worst(next) > room) {
      // MONEY-3: the most the bet on the worst pocket could be (the rest of the line as typed) - within its own limits,
      // rounded down to the minimum (decision 10), and offered only when a line with it is admitted. A worst pocket the
      // line doesn't cover isn't lowered by more of it: nothing to offer.
      const peak = next.indexOf(engine.worst(next)),
        b = bets.find((x) => x.nums.includes(peak));
      let more = 0;
      if (b) {
        const rest = e.book.concat({ uid, bets: bets.filter((x) => x !== b) }),
          total = sum([...limited.amounts.values()]);
        const head = Math.min(
          engine.maxMore(engine.lossVector(rest), b, room),
          capFor(T, b) - (limited.amounts.get(b.token) - b.amount),
          L.max_spin - (total - b.amount),
        );
        more = Math.floor(head / L.min) * L.min;
        if (more < L.min || engine.worst(engine.lossVector(rest.concat({ uid, bets: [{ ...b, amount: more }] }))) > room)
          more = 0;
      }
      const token = (b || bets[0]).token;
      return no(
        more > 0
          ? "🏦 The wheel can take at most " + fmt(more) + " more on " + token + " this spin."
          : "🏦 The wheel can't take more on " + token + " this spin.",
        "E_BANK",
        { more, token },
      );
    }
    return null;
  }
  // the header and the act key's answer together (no PAT moves: a queued line, a cleared queued line). (O2, review) While
  // the wheel spins its header carries the drawn book for release A's mirror (~1 MB on a full wheel), so it is not
  // rewritten for a queued line: the player's queued line - or its clearing - is their casino_rl_queue row, committed with
  // the answer (rlstore.queue). The landing's header takes the queued lines over; load() puts them back after a restart.
  async function saveAnswer(T, out, uid, key) {
    await store.ensure();
    const spinning = T.eng.phase === "spinning" && !!T.round && !!uid;
    try {
      await tx(async () => {
        if (spinning) {
          const q = T.eng.pending[uid];
          await store.queue(T.id, T.round.no, uid, q ? q.bets : null, q ? T.players[uid] || null : null, T.rev, key, clock());
        } else await save(T);
        if (key) await answer(T, key, uid, out);
      });
    } catch (e) {
      await restore(T);
      throw e;
    }
    if (spinning) wake(T); // (after the commit, as save's own wake would have been)
    return out;
  }
  async function place(T, actor, bets, key, queued = false) {
    await hydrate(T);
    const why = (await gate(actor)) || (await checkSeat(T, actor));
    if (why) return refuse(why);
    if (T.closing || copyOf(T)) return reply(false, "🛞 This wheel closes after this spin — no new bets.");
    const e = T.eng,
      uid = actor.uid;
    if (["result", "spinning"].includes(e.phase)) {
      // A queued line is checked now as far as it can be (ENGINE-4 / SUITES-2): a room wheel that closes after this spin
      // opens no next spin, and the limits and the balance refuse it now with the reason. The bank and a balance spent
      // meanwhile are checked when betting opens; a refusal then is told privately (queuedLines). (D3: the limits it is
      // checked against now are this spin's; the next spin's own are checked when it is charged.)
      if (!T.lobby && rotation(T))
        return reply(false, "🛞 This wheel closes after this spin — no new bets. " + reopen(T)[0].toUpperCase() + reopen(T).slice(1) + " then.");
      if (!e.pending[uid] && Object.keys(e.pending).length >= lim(T).max_players)
        return reply(false, "The next spin is full.");
      const limited = lineLimits(T, bets, [], actor.via === "web");
      if (limited.why) return refuse(limited.why);
      const u = await userRow(uid);
      if (!u || !(Number(u.points_balance) >= amountOf(bets)))
        return reply(false, "You don't have enough available PAT for that line.");
      const previous = e.pending[uid];
      seat(T, actor);
      e.pending[uid] = { bets };
      if (e.notes) delete e.notes[uid];
      return saveAnswer(
        T,
        reply(
          true,
          (previous ? "⏳ Replaced your queued line: " : "⏳ Queued for the next spin: ") +
            describe(bets, actor.via === "web") +
            " (charged when betting opens)" +
            (T.next ? " · 🔐 spin " + T.next.no + " committed " + T.next.commitment.slice(0, 12) + "…" : "") +
            ".",
        ),
        uid,
        key,
      );
    }
    const blocked = await checkLine(T, actor, bets);
    if (blocked) return refuse(blocked);
    if (e.phase === "betting" && clock() >= T.dl.bet)
      return reply(false, "No more bets — wait for the next spin.");
    // (O2) ONE transaction: the stake (ledger.post joins it), the line's row, the header and the act key's answer commit
    // together - or nothing does. A refused charge writes nothing; anything that throws after it rolls the charge back.
    const amount = amountOf(bets),
      opno = T.opno + 1,
      line = { uid, bets, amount, key: spinKey(T) + ":" + uid + ":b" + opno };
    crash("intent");
    let ans,
      announce = [];
    try {
      ans = await tx(async () => {
        const charge = await money.charge(line.key, uid, amount, "roulette bet");
        if (!charge.ok) return null;
        if (charge.replay) throw Object.assign(Error("Stake key " + line.key + " was charged already"), { code: "E_KEY" });
        crash("charge");
        await store.insert(T.id, e.round_no, line, opno, key, clock());
        crash("row");
        T.opno = opno;
        seat(T, actor);
        e.book.push(line);
        T.stakes.push({ key: line.key, uid, amount });
        T.escrowed[uid] = (T.escrowed[uid] || 0) + amount;
        e.actions[uid] = (e.actions[uid] || 0) + 1;
        T.last_activity = clock();
        if (e.notes) delete e.notes[uid];
        if (queued) delete e.pending[uid];
        if (e.phase === "idle") {
          e.phase = "betting";
          T.dl.bet = clock() + S.settings.rl_bet_secs * 1000;
          // the first line's "Bets are open" goes out once the line has committed (below; no second write of the wheel -
          // the next save carries its log line): a poll never reads an event of a transaction that can still roll back
          announce = roomsOf(T).filter((id) => annDue(T, "open_ts", id));
        }
        const out = reply(
          true,
          "✅ On the wheel: " +
            describe(bets, actor.via === "web") +
            " — " +
            fmt(T.escrowed[uid]) +
            " PAT on this spin from you (spins in " +
            Math.ceil((T.dl.bet - clock()) / 1000) +
            "s).",
        );
        await save(T);
        if (key) await answer(T, key, uid, out);
        crash("answer");
        return out;
      });
    } catch (err) {
      await restore(T);
      if (err.code === "E_KEY") T.opno = Math.max(T.opno, opno); // (never offered again: rlstore.strays settles it at boot)
      throw err;
    }
    if (ans && announce.length)
      await emit(T, "line", "🛞 Bets are open.", { rooms: announce }).catch((err) =>
        console.error("[casino] roulette " + T.id + " bets-open line:", err.message),
      );
    return ans || reply(false, "The stake could not be charged. Check your available PAT.");
  }
  function dropLines(T, keys) {
    const gone = new Set(keys);
    T.eng.book = T.eng.book.filter((l) => !gone.has(l.key));
    syncStakes(T);
  }
  // (O2) undo, clear, end, copy and an older build's interrupted refund: ONE transaction. Each line flips live ->
  // refunded only if it is still live (a line refunded already is skipped) and its <key>:refund is credited with the
  // flip; a credit that fails rolls every flip and credit of the call back. Then the header and the act key's answer.
  async function refund(T, lines, why, uid, key) {
    await hydrate(T);
    const e = T.eng,
      keys = lines.map((l) => l.key);
    try {
      return await tx(async () => {
        let amount = 0;
        for (const l of lines) {
          if (!(await store.close(l.key, "refunded", why, clock()))) continue;
          const paid = await money.credit(l.key + ":refund", l.uid, l.amount, "roulette refund (" + why + ")");
          if (!paid.ok) throw Error("Wheel refund pending");
          amount += l.amount;
          crash("refund");
        }
        dropLines(T, keys);
        if (uid) e.actions[uid] = (e.actions[uid] || 0) + 1;
        if (why === "clear") delete e.pending[uid];
        if (!e.book.length && e.phase === "betting") {
          e.phase = "idle";
          T.dl = {};
        }
        const out = reply(true, "Refunded " + fmt(amount) + " PAT.");
        await save(T);
        if (key) await answer(T, key, uid, out);
        return out;
      });
    } catch (err) {
      await restore(T);
      throw err;
    }
  }
  // (the draw's first step) the cached book must be the open spin's live rows: the draw freezes that set. A wheel whose
  // close is owed (T.ending: its refund or reveal failed) or a copy is never drawn - recover() finishes it first.
  async function discardRefunded(T) {
    if (T.ending || copyOf(T)) throw Error("Roulette wheel " + T.id + " is closing: not drawn");
    await hydrate(T);
    const n = openRound(T),
      rows = n == null ? [] : await store.liveKeys(T.id, n),
      cached = new Set(T.eng.book.map((l) => l.key));
    if (rows.length !== cached.size || rows.some((k) => !cached.has(k))) {
      console.warn("[casino] roulette " + T.id + ": the cached book was not the live rows - reloaded");
      await load(T);
    }
  }
  async function draw(T) {
    await discardRefunded(T);
    if (!T.eng.book.length) {
      T.eng.phase = "idle";
      T.dl = {};
      await save(T);
      return;
    }
    crash("predraw");
    // The pocket is public only once its draw has committed. Every reader (the web poll, Pepe's long-poll, the OBS
    // board) reads the live table without the casino lock, so the spinning state is saved from a copy and reaches the
    // live table after COMMIT. A draw that fails leaves the live wheel betting as it was: nobody saw its pocket.
    // FAIR-3: and the next spin is committed now (unless this wheel closes after this spin), before any line is queued for it
    // 1.99aoh(c): dl.start = the spin's start on the site's clock (saved with the spin, so a board arriving mid-spin can place it)
    const r = { ...T.round, pocket: fair.spinPocket(T.round.seed, T.client_seed, T.round.no) },
      t0 = clock(),
      dl = { start: t0, land: t0 + S.settings.rl_spin_secs * 1000 },
      ahead = !T.closing && S.settings.casino_roulette !== "off" && !rotation(T) ? fair.newServerSeed() : null,
      upcoming = ahead ? { seed: ahead, commitment: fair.commitment(ahead), no: r.no + 1 } : null,
      next = { ...T, round: r, eng: { ...T.eng, phase: "spinning" }, dl, next: upcoming };
    const players = Object.keys(T.escrowed).map((uid) => ({ uid, name: T.players[uid].name }));
    await tx(async () => {
      await emit(
        T,
        "line",
        "🛑 No more bets — " +
          players.length +
          " players, " +
          fmt(sum(Object.values(T.escrowed))) +
          " PAT on the wheel.",
      );
      await save(next);
      await runQuery("UPDATE casino_rounds SET players=?,dealt=? WHERE table_id=? AND round_no=?", [
        JSON.stringify(players),
        clock(),
        T.id,
        r.no,
      ]);
      if (upcoming)
        await runQuery(
          "INSERT INTO casino_rounds (table_id,round_no,commitment,client_seed,num_decks,created) VALUES (?,?,?,?,0,?)",
          [T.id, upcoming.no, upcoming.commitment, T.client_seed, clock()],
        );
    });
    Object.assign(T, { round: r, dl, next: upcoming, rev: next.rev, updated: next.updated });
    T.eng.phase = "spinning";
    wake(T);
    crash("draw");
    await advertRepeat(T);
  }
  // Rebet stores the previous stake per position. Repeated equivalent lines do not
  // lengthen a saved slip on every subsequent round.
  function combinedSlip(lines) {
    const positions = new Map();
    for (const line of lines)
      for (const bet of line.bets) {
        const previous = positions.get(bet.token);
        if (previous) previous.amount += bet.amount;
        else positions.set(bet.token, { ...bet });
      }
    return [...positions.values()];
  }
  // (O2) a saved slip is [[token, amount], ...]; a player no longer seated takes theirs along
  const packSlip = (slip) => slip.map((b) => (Array.isArray(b) ? [b[0], b[1]] : [grammar.token(b), b.amount]));
  function slipsAfter(T, lines, results) {
    const out = {};
    for (const [uid, s] of Object.entries(T.eng.slips || {})) if (T.eng.seats.includes(uid)) out[uid] = s;
    for (const uid of Object.keys(results)) out[uid] = packSlip(combinedSlip(lines.filter((l) => l.uid === uid)));
    return out;
  }
  // (O2) ONE transaction settles the set the draw froze - the spin's live rows: each player's keyed payout, the House
  // legs (flashCover only books a claim row: DB-only), the rows -> settled, the reveal, the header and its result line. A
  // throw anywhere rolls all of it back (the next tick lands again; each key moves PAT once). The rewards run after the
  // commit with the same lines. quiet (a copied wheel retiring an older build's interrupted settlement): the keyed money
  // and the rows only - no reveal, no line, no rewards.
  async function land(T, opts = {}) {
    await hydrate(T);
    const quiet = !!opts.quiet,
      e = T.eng,
      r = T.round,
      key = spinKey(T),
      p = r.pocket;
    let lines = [],
      results = {};
    try {
      await tx(async () => {
        lines = await store.live(T.id, r.no);
        results = engine.settle(lines, p);
        const winners = [];
        let gained = 0,
          paid = 0;
        for (const [uid, x] of Object.entries(results)) {
          const credit = await money.credit(key + ":" + uid + ":pay", uid, x.returned, "roulette payout");
          if (!credit.ok) throw Error("Wheel settlement pending");
          if (x.net > 0) {
            paid += x.net;
            winners.push({ uid, net: x.net });
          } else gained -= x.net;
        }
        crash("payouts");
        if (gained) await money.house(key + ":house+", key, null, gained);
        crash("house+");
        if (paid && !(await money.houseDone(key + ":house-"))) {
          await money.flashCover(key + ":house-", paid, "roulette");
          crash("flash");
          await money.house(key + ":house-", key, null, -paid);
        }
        crash("house-");
        await store.settle(T.id, r.no, clock());
        await store.unqueue(T.id); // (the header below carries the queued lines again)
        if (quiet) {
          e.book = [];
          syncStakes(T);
          r.settle = "done";
          await save(T);
          return;
        }
        winners.sort((a, b) => b.net - a.net);
        const kept = winners.slice(0, 3),
          house = gained - paid,
          proof = fairLink(T, r.no);
        const last = {
          round_no: r.no,
          number: p,
          color: engine.color(p),
          house_net: house,
          proof,
          others_won: Math.max(0, winners.length - 3),
          winners: kept.map((w) => ({
            seat: V.seatOf(T, w.uid),
            name: V.nameOf(T, w.uid, T.players[w.uid].name),
            net: w.net,
          })),
        };
        const parts = kept.map((w) => T.players[w.uid].name + " +" + fmt(w.net));
        if (last.others_won) parts.push(last.others_won + " more won");
        const text =
          pocketText(p) +
          (parts.length ? " — 🏆 " + parts.join(" · ") : "") +
          " · 🏦 House " +
          (house >= 0 ? "+" : "") +
          fmt(house) +
          " PAT · 🔐 " +
          proof;
        await runQuery(
          "UPDATE casino_rounds SET shoe=?,results=?,server_seed=?,revealed=? WHERE table_id=? AND round_no=?",
          [JSON.stringify({ pocket: p, pockets: 37 }), JSON.stringify(last), r.seed ?? null, clock(), T.id, r.no],
        );
        crash("round");
        e.slips = slipsAfter(T, lines, results);
        e.lastslip = {};
        T.last_round = last;
        e.net = Object.fromEntries(Object.entries(results).map(([u, x]) => [u, x.net]));
        e.history = e.history.concat({ round_no: r.no, number: p, color: last.color }).slice(-20);
        T.last_activity = clock();
        T.last_revealed = r.no;
        e.book = [];
        syncStakes(T);
        delete r.results;
        r.settle = "done";
        e.phase = "result";
        T.dl = { result: clock() + S.settings.rl_result_secs * 1000 };
        await emit(T, "result", text);
        crash("result");
        await save(T);
      });
    } catch (err) {
      await restore(T);
      throw err;
    } finally {
      houseAt = null;
    }
    settledLines.set(T, { round: r.no, lines });
    if (quiet) return;
    crash("landed");
    try {
      await require("./rewards").rouletteSpin(T, r.no, results, p, lines);
    } catch (err) {
      // Reward outages have no bearing on a completed PAT settlement.
      console.error("[casino] roulette rewards:", err.message);
    }
    crash("rewards");
  }
  // O10 + the rewards: the lines of the wheel's spin - while it takes bets its live lines, once drawn the set the draw froze,
  // while its result is up the set that landed (until the next spin opens: nextSeed). The cached objects: read only.
  function frozenLines(T) {
    if (!T || T.game !== "roulette" || !T.eng) return [];
    if (T.eng.phase === "result") {
      const f = settledLines.get(T);
      return f && T.round && f.round === T.round.no ? f.lines.slice() : [];
    }
    return (T.eng.book || []).slice();
  }
  // opts.keepStream (1.99aoj: a lobby rotation) - the stream slot is not freed here; succeed() hands it (and an admin's pin) to
  // the successor wheel, or frees it when there is none
  async function closeTable(T, reason, opts = {}) {
    if (T.status !== "open") return;
    if (T.eng.phase === "spinning") {
      T.closing = true;
      await save(T);
      return;
    }
    // Bets stop (committed) before anything is revealed: a reader can see the unused seed while the reveal's
    // transaction is open, and a reveal that fails must leave a wheel that takes no bet on that round. (O2, review) The
    // same save marks the close as owed (T.ending): a refund or reveal that fails, or a restart in between, is resumed by
    // the next tick or boot (recover) before the wheel could draw - nothing else journals it now.
    if (!T.closing || !T.ending) {
      T.closing = true;
      T.ending = reason || "closed";
      await save(T);
    }
    await hydrate(T); // (O2) the book is the live rows before the close refunds them
    if (T.eng.book.length) await refund(T, T.eng.book, "end", null, null);
    try {
      await tx(async () => {
        // every unused commitment is revealed: the current round when it never spun, and the next spin committed at a draw
        const unused = [T.round.settle ? null : T.round, T.next && T.next.seed ? T.next : null].filter(Boolean);
        for (const u of unused)
          await runQuery(
            "UPDATE casino_rounds SET server_seed=?,shoe=?,revealed=? WHERE table_id=? AND round_no=?",
            [
              u.seed,
              JSON.stringify({ pocket: fair.spinPocket(u.seed, T.client_seed, u.no), pockets: 37 }),
              clock(),
              T.id,
              u.no,
            ],
          );
        crash("reveal");
        T.next = null;
        T.last_revealed = T.round.no;
        T.status = "closed";
        T.closed_at = clock();
        T.dl = {};
        delete T.ending; // (the close it marked is done)
        for (const [uid, line] of Object.entries(T.eng.pending)) tell(T, uid, line.bets, "the wheel closed.");
        T.eng.pending = {};
        await emit(T, "closed", closedText(T, reason), { reason });
        await save(T);
      });
    } catch (err) {
      await restore(T); // (the wheel stays open with its close owed: the next tick or boot resumes it)
      throw err;
    }
    if (!opts.keepStream) streamGone(T.id);
  }
  // the closed line: a full room wheel says !rl start, a full web wheel the casino lobby
  function closedText(T, reason) {
    if (reason === "full") return "🛞 The roulette wheel closed: it reached 35 players. " + reopen(T)[0].toUpperCase() + reopen(T).slice(1) + ".";
    if (reason === "rotated") return "🛞 This lobby wheel closed; a fresh one is open.";
    return "🛞 The roulette wheel closed.";
  }
  const rotation = (T) =>
    Object.keys(T.veil || {}).length >= 35 || (T.lobby && clock() - T.created >= 86400000);
  async function advance(T) {
    const off = S.settings.casino_roulette === "off";
    if (T.closing || off || rotation(T)) {
      // ENGINE-4: the lobby rotates (a day, or 35 people) - its queued lines move to the fresh lobby wheel and are
      // charged when its window opens; its page follows the successor (publicView next_table). 1.99aoj (D7): its place on
      // Pepe's stream - and an admin's pin - go to the successor too (succeed)
      const carry = T.lobby && !T.closing && !off ? T.eng.pending : {};
      if (Object.keys(carry).length) T.eng.pending = {};
      const successor = T.lobby && !off;
      await closeTable(T, T.closing || off ? "wheel finished" : T.lobby ? "rotated" : "full", { keepStream: successor });
      if (successor && T.status === "closed") await succeed(T, carry);
      return;
    }
    await nextSeed(T);
    await queuedLines(T);
  }
  // A closed lobby's successor: the same house slot, its queued lines, and its place on Pepe's stream (the slot or the queue,
  // with an admin's pin) - or, with no successor, the stream place is freed as any close frees it
  async function succeed(T, carry) {
    let N = null;
    try {
      N = await ensureLobby();
    } catch (e) {
      console.error("[casino] the next lobby wheel:", e.message);
    }
    if (!N || N === T) {
      streamGone(T.id);
      for (const [uid, line] of Object.entries(carry)) tell(T, uid, line.bets, "the wheel closed.");
      await save(T);
      return;
    }
    if (T.slot) N.slot = T.slot;
    const streamed = streamHandOff(T.id, N.id);
    for (const [uid, line] of Object.entries(carry)) {
      N.players[uid] = N.players[uid] || T.players[uid];
      N.eng.pending[uid] = line;
    }
    if (Object.keys(carry).length || streamed) await save(N);
    T.successor = N.id;
    await save(T);
  }
  async function queuedLines(T) {
    for (const [uid, line] of Object.entries(T.eng.pending)) {
      const actor = { ...T.players[uid], uid, veil: await V.kindForUid(uid, T.players[uid]) };
      const out = await place(T, actor, line.bets, null, true);
      if (!out.ok) {
        delete T.eng.pending[uid];
        tell(T, uid, line.bets, out.reply);
        await save(T);
      }
    }
  }
  // SUITES-2 / MONEY-9: a queued line refused when betting opens, or dropped by a close, is told privately - the page's
  // and the Dock's meView.private_note and, for a Camfrog room player, a PM through Pepe's poll (privateNotes).
  function tell(T, uid, bets, why) {
    const e = T.eng,
      text = "Your queued line (" + describe(bets) + ") wasn't placed: " + why;
    e.notes = { ...e.notes, [uid]: text };
    const p = T.players[uid] || {};
    if (p.via !== "room" || !p.camfrog || !p.room) return;
    e.pmno = (e.pmno || 0) + 1;
    e.pms = (e.pms || [])
      .filter((m) => clock() - m.ts < PM_MS)
      .concat({ key: "rl:" + T.id + ":" + e.pmno, camfrog: p.camfrog, room: p.room, text: "🛞 " + text, ts: clock() })
      .slice(-20);
  }
  // Pepe's poll (`private_mtt`, which he PMs by kind "notice": each key once, only down the player's own room)
  const PM_MS = 120000;
  function privateNotes() {
    const out = [];
    for (const T of S.tables.values())
      if (T.game === "roulette")
        for (const m of T.eng.pms || [])
          if (clock() - m.ts < PM_MS)
            out.push({ kind: "notice", key: m.key, camfrog: m.camfrog, room: m.room, table: T.id, text: m.text });
    return out;
  }
  function due(T) {
    const e = T.eng,
      now = clock();
    return (
      !!T.intent ||
      !!T.ending ||
      copyOf(T) ||
      (e.phase === "betting" && now >= T.dl.bet) ||
      (e.phase === "spinning" && now >= T.dl.land) ||
      (e.phase === "result" && now >= T.dl.result) ||
      (e.phase === "idle" &&
        (T.closing ||
          S.settings.casino_roulette === "off" ||
          rotation(T) ||
          (!T.lobby && now - T.last_activity >= 60000 * S.settings.rl_idle_close_mins) ||
          Object.keys(e.pending).length ||
          e.seats.some((u) => now - e.seen[u] >= 600000)))
    );
  }
  async function tick(T) {
    if (T.status !== "open" || !due(T)) return;
    // (O2: a wheel whose rows this process hasn't read yet; review: a close that is owed, a copy to retire)
    if (T.intent || T.ending || copyOf(T) || !reconciled.has(T)) return recover(T);
    if (T.eng.phase === "spinning") return land(T);
    if (T.eng.phase === "betting") return draw(T);
    if (T.eng.phase === "result") return advance(T);
    // 1.99aoj (D7): an idle lobby wheel's rotation (a day, or 35 people) goes the way a landed one's does - its successor takes
    // its slot, its queued lines and its place on Pepe's stream (advance -> succeed)
    if (T.lobby && rotation(T) && !T.closing && S.settings.casino_roulette !== "off") return advance(T);
    if (
      T.closing ||
      S.settings.casino_roulette === "off" ||
      rotation(T) ||
      (!T.lobby && clock() - T.last_activity >= S.settings.rl_idle_close_mins * 60000)
    )
      return closeTable(T, "idle");
    pruneInactive(T);
    await queuedLines(T);
    await save(T);
  }
  // (O2) This build journals nothing (its money and rows commit together). An intent in the JSON is either its own
  // rollback mirror (ignored: the rows hold those lines) or an older build's, finished by that build's rules: the rest of
  // an interrupted refund, by key; an interrupted placement's stake back if it was charged (with a row for the record).
  async function finishIntent(T) {
    const it = T.intent;
    if (!it) return;
    if (it.mirror) {
      T.intent = null;
      return;
    }
    if (Array.isArray(it.refund)) {
      const keys = new Set(it.refund);
      T.intent = null;
      await refund(T, T.eng.book.filter((l) => keys.has(l.key)), it.why || "restart", it.uid || null, it.actKey || null);
      return;
    }
    try {
      await tx(async () => {
        const k = store.parseKey(it.key);
        if (k && (await money.isDone(it.key)) && !(await getQuery("SELECT 1 FROM casino_rl_lines WHERE key=?", [it.key])).length) {
          const paid = await money.credit(it.key + ":refund", it.uid, it.amount, "roulette refund (restart)");
          if (!paid.ok) throw Error("Stake recovery pending");
          await store.insert(T.id, k.round, { key: it.key, uid: it.uid, bets: [], amount: it.amount }, k.opno, null, clock(), "refunded", "restart");
        }
        T.intent = null;
        await save(T);
      });
    } catch (e) {
      await restore(T);
      throw e;
    }
  }
  // (O2) a stake debit of the open spin with no row (an older build charged it, then stopped before its book had it)
  async function strayStakes(T) {
    const n = openRound(T);
    if (n == null) return;
    const since = store.flags.length;
    const found = await tx(() => store.strays(T.id, n, clock()));
    for (const s of found) T.opno = Math.max(T.opno, store.parseKey(s.key).opno); // (its key is never offered again)
    report(since);
  }
  // FAIR-1 (1.99aof): a wheel copied from another database - deploy/keep-staging-tables.js strips an open wheel's secret
  // seed from a staging copy and marks it `copied`. That database's wheel may still take bets on this very round (the
  // lobby can wait a day for its first bet), so the copy is never played or revealed here: a drawn spin's keyed payouts
  // finish (its pocket was already shown there), every line on its book is refunded, and it closes with its commitment
  // unrevealed.
  async function retireCopy(T) {
    await finishIntent(T);
    await strayStakes(T);
    if (T.round?.settle === "pending") await land(T, { quiet: true }); // (an older build's interrupted settlement)
    if (T.eng.book.length) await refund(T, T.eng.book, "copy", null, null);
    if (T.round) delete T.round.pocket;
    T.eng.phase = "idle";
    T.eng.pending = {};
    T.status = "closed";
    T.closed_at = clock();
    T.dl = {};
    await save(T);
    console.log("[casino] " + T.id + ": a roulette wheel copied from another database closed unrevealed");
  }
  async function recover(T) {
    await hydrateAll(T); // (O2) every open wheel's rows, before this one acts
    if (copyOf(T)) return retireCopy(T);
    await finishIntent(T);
    await strayStakes(T);
    // (O2) the rewards follow the landing's commit: a restart while its result is up runs them again (each one is keyed)
    const landed = T.eng.phase === "result" && settledLines.get(T);
    if (landed && landed.lines.length && T.round.pocket != null)
      await require("./rewards")
        .rouletteSpin(T, landed.round, engine.settle(landed.lines, T.round.pocket), T.round.pocket, landed.lines)
        .catch((e) => console.error("[casino] roulette rewards:", e.message));
    // (review) a close that began and did not finish (its refund or reveal failed, or a restart cut it) finishes now,
    // before anything else: a wheel its host ended never plays the spin instead
    if (T.ending && T.eng.phase !== "spinning") return closeTable(T, T.ending);
    if (T.eng.phase === "betting" && T.dl.bet <= clock()) {
      T.dl.bet = clock() + S.settings.rl_bet_secs * 1000;
      await save(T);
    }
    if (T.round?.settle === "pending") return land(T);
    if (T.eng.phase === "idle" || T.eng.phase === "betting") await queuedLines(T);
    if (due(T)) await tick(T);
  }
  const spinStart = (T) => T.dl.start || T.dl.land - S.settings.rl_spin_secs * 1000;
  // 1.99aoj: the rules object - the same lim(T) the checks read, the timers, and the bank's straight headroom (bankRefresh's
  // cached figure: null until it has been worked out, and null again once it is BANK_SHOWN_MS old - review: a wheel nobody has
  // viewed on the web for hours never shows that old figure; the web view and Pepe's poll refresh it first)
  function rules(T) {
    const L = lim(T),
      s = S.settings,
      c = bankCache.get(T.id),
      hit = c && c.at <= clock() && clock() - c.at < BANK_SHOWN_MS ? c : null;
    return {
      min: L.min,
      caps: { ...L.caps },
      kinds: { ...KINDS },
      max_spin: L.max_spin,
      max_positions: L.max_positions,
      max_actions: L.max_actions,
      max_players: L.max_players,
      max_people: 35,
      bet_secs: s.rl_bet_secs,
      spin_secs: s.rl_spin_secs,
      result_secs: s.rl_result_secs,
      bank_straight: hit && hit.value != null ? hit.value : null,
    };
  }
  // 1.99aoj (D5, O10 option C): the CHARGED lines of the wheel's spin (frozenLines: live while betting, frozen once drawn, the
  // landed set while the result is up; never a queued line) - each seat's chips combined per position, and the felt's total
  // and player count per position. Keyed by the seat only (V.seatOf / V.nameOf below): no account id.
  function chipsOf(T) {
    const bySeat = new Map(),
      felt = new Map();
    for (const l of frozenLines(T)) {
      const mine = bySeat.get(l.uid) || new Map();
      bySeat.set(l.uid, mine);
      for (const b of l.bets) {
        const t = b.token || grammar.token(b);
        mine.set(t, (mine.get(t) || 0) + b.amount);
        const f = felt.get(t) || { t, n: 0, who: new Set() };
        f.n += b.amount;
        f.who.add(l.uid);
        felt.set(t, f);
      }
    }
    return {
      seat: (uid) => [...(bySeat.get(uid) || new Map())].slice(0, 60),
      felt: [...felt.values()].map((f) => ({ t: f.t, n: f.n, k: f.who.size })),
    };
  }
  function publicView(T) {
    const e = T.eng,
      L = lim(T),
      chips = chipsOf(T),
      result = e.phase === "result" && T.status === "open";
    return {
      id: T.id,
      game: "roulette",
      status: T.status,
      rev: T.rev,
      lobby: T.lobby,
      host: T.lobby ? "Pepe" : V.hostName(T),
      rooms: roomList(T),
      room: T.room,
      room_name: roomList(T)[0]?.name || null,
      adverts: advertList(T),
      url: link(T),
      // 1.99aoj (contract 2): the tier, the house slot (the lobby's), the look, the seats and the limits in the shared shape
      tier: high(T) ? "hr" : "main",
      high_stakes: high(T),
      slot: T.lobby ? T.slot || "main" : null,
      theme: "classic",
      max_seats: L.max_players,
      min_bet: L.min,
      max_bet: L.max_spin,
      rules: rules(T),
      felt: chips.felt,
      phase: T.status === "closed" ? "closed" : e.phase,
      next_table: T.successor || null,
      round_no: e.round_no,
      client_seed: T.client_seed,
      commitment: T.round.commitment,
      commit_round: T.round.no,
      // FAIR-3: while a spin is in the air (or its result is up), the next spin's commitment - a queued line's spin
      next_commitment: T.next ? T.next.commitment : null,
      next_round: T.next ? T.next.no : null,
      last_revealed: T.last_revealed,
      deadline: T.dl.bet || null,
      land_at: T.dl.land || null,
      result_until: T.dl.result || null,
      // (null unless the LIVE phase is spinning: the pocket is public only once its draw committed)
      // 1.99aoh(c): + started_at (site ms) and secs - a spin saved before dl.start existed counts back from its landing
      spin:
        e.phase === "spinning"
          ? {
              round_no: e.round_no,
              number: T.round.pocket,
              color: engine.color(T.round.pocket),
              started_at: spinStart(T),
              ends_at: T.dl.land,
              secs: (T.dl.land - spinStart(T)) / 1000,
            }
          : null,
      // (D5: staked = the seat's chips - the charged lines of this spin; while the result is up, the spin that landed - and net)
      seats: e.seats.map((uid) => {
        const mine = chips.seat(uid);
        return {
          name: V.nameOf(T, uid, T.players[uid].name),
          seat: V.seatOf(T, uid),
          host: uid === T.host.uid,
          staked: sum(mine.map((c) => c[1])),
          chips: mine,
          ...(result ? { net: e.net?.[uid] ?? null } : {}),
          ...(V.masked(T, uid) ? { veil: 1 } : {}),
        };
      }),
      totals: { players: Object.keys(T.escrowed).length, staked: sum(Object.values(T.escrowed)) },
      history: e.history.slice(),
      last_round: V.maskRound(T, T.last_round),
      limits: limits(T),
      log: V.maskLog(T, T.log),
    };
  }
  // The one-time intro notice is taken (a write: casino_notice_seen) only when the caller will show it - the table page's
  // and the Room Dock's first request ask with ?notice=1; their 1-2 s polls are reads.
  async function meView(T, uid, opts = {}) {
    const lines = own(T, uid),
      perToken = {};
    for (const b of lines.flatMap((l) => l.bets)) perToken[b.token] = (perToken[b.token] || 0) + b.amount;
    return {
      host: !T.lobby && T.host.uid === uid,
      lines: lines.map((l) => ({ text: describe(l.bets), amount: l.amount })),
      staked: T.escrowed[uid] || 0,
      pending: T.eng.pending[uid] ? describe(T.eng.pending[uid].bets) : null,
      last_slip: lastSlip(T, uid) ? describe(lastSlip(T, uid)) : null,
      room_left: Math.max(0, lim(T).max_spin - (T.escrowed[uid] || 0)),
      net: T.eng.net?.[uid] ?? null,
      private_note: T.eng.notes?.[uid] || null,
      notice: opts.notice ? await require("./notices").take("rl_intro", uid, clock(), S.settings) : null,
      // 1.99aoj (contract 2): the viewer's own seat id (as the seats list keys it), the role, and what they have used this spin
      seat: T.eng.seats.includes(uid) ? V.seatOf(T, uid) : null,
      high_roller: await isHighRoller(uid),
      used: { positions: Object.keys(perToken).length, actions: T.eng.actions[uid] || 0, per_token: perToken },
    };
  }
  // Pepe's poll (`roulette`) and the lobby's wheel list - 1.99aoj (contract 5): + the tier, the limits and the clock
  function openList() {
    // (review) the lobby wheel first (then in the order they opened): a client that shows the first few always shows it
    return open()
      .sort((a, b) => !!b.lobby - !!a.lobby)
      .map((T) => {
        const L = lim(T);
        return {
          id: T.id,
          url: link(T),
          rooms: roomsOf(T),
          room_name: roomList(T)[0]?.name || null,
          players: T.eng.seats.length,
          phase: T.eng.phase,
          lobby: T.lobby,
          tier: high(T) ? "hr" : "main",
          high_stakes: high(T),
          min_bet: L.min,
          max_straight: L.caps.straight,
          max_spin: L.max_spin,
          deadline: T.dl.bet || null,
          land_at: T.dl.land || null,
          slot: T.lobby ? T.slot || "main" : null,
        };
      });
  }
  // the casino lobby's row for a wheel (contract 3): service.lobby() adds the shared fields (host, rooms, adverts, url, stream)
  function lobbyRow(T) {
    const L = lim(T),
      e = T.eng;
    return {
      game: "roulette",
      phase: e.phase,
      players: e.seats.length,
      max_seats: L.max_players,
      high_stakes: high(T),
      tier: high(T) ? "hr" : "main",
      theme: "classic",
      round_no: e.round_no,
      min_bet: L.min,
      max_bet: L.max_spin,
      max_straight: L.caps.straight,
      lobby: !!T.lobby,
      slot: T.lobby ? T.slot || "main" : null,
      deadline: T.dl.bet || null,
      land_at: T.dl.land || null,
      staked: sum(Object.values(T.escrowed)),
      last: e.history.slice(-8).map((x) => x.number),
    };
  }
  async function lobby(uid) {
    const on = !(await shut({ uid }));
    const wheels = on ? openList() : [];
    return { on, lobby: wheels.find((w) => w.lobby) || null, wheels };
  }
  async function run(actor, verb, args, opts) {
    const T = opts.table && S.tables.get(opts.table);
    if (verb === "start") {
      // 1.99aoj (D1): "!rl start [hr]" in a room opens that room's wheel; the web's POST /api/casino/open {game: "roulette", hr}
      // opens a WEB wheel (room null) hosted by the opener. cmdStart (service.js) checks one table per room, the one open web
      // wheel per host, max_tables and the High Roller role (HR_ONLY_OPEN) before RL.start.
      const why = await gate(actor);
      if (why) return reply(false, why);
      if (actor.via === "room" && !opts.room) return reply(false, "Open a room wheel with !rl start in the room.");
      const words = (Array.isArray(args) ? args : []).map((w) => String(w || "")).filter(Boolean);
      return cmdStart(actor, actor.via === "room" ? opts.room : null, "roulette", words[0], words);
    }
    if (T && T.game !== "roulette")
      return reply(
        false,
        T.game === "holdem"
          ? "A Hold'em table is running here — !holdem status."
          : "A blackjack table is running here — !bj status.",
      );
    const why = await shut(actor);
    if (why) return reply(false, why);
    if (verb === "help") return reply(true, HELP);
    if (!T || T.status !== "open")
      return reply(
        false,
        "No wheel here. Use !rl start or play on the web: " +
          link({ game: "roulette", id: "x" }).replace(/\/t\/x$/, ""),
      );
    if (T.intent) await recover(T);
    const uid = actor.uid,
      e = T.eng,
      lines = own(T, uid),
      key = opts.act_key;
    if (["bet", "rebet", "undo", "clear", "go", "end"].includes(verb)) {
      const blocked = await gate(actor);
      if (blocked) return reply(false, blocked);
    }
    if (verb === "bet" || verb === "rebet") {
      const parsed =
        verb === "rebet"
          ? { ok: !!lastSlip(T, uid), bets: lastSlip(T, uid), error: "No previous spin to repeat.", hint: "" }
          : grammar.parse(args[0], { maxPairs: actor.via === "web" ? 20 : 6, minBet: lim(T).min });
      return parsed.ok ? place(T, actor, parsed.bets, key) : reply(false, parsed.error + " " + parsed.hint);
    }
    if (verb === "clear" || verb === "undo") {
      if (["spinning", "result"].includes(e.phase)) {
        if (verb === "undo") return reply(false, "No more bets — your lines ride.");
        delete e.pending[uid];
        return saveAnswer(T, reply(true, "Cleared your queued line. This spin's lines are in play."), uid, key);
      }
      if (!lines.length || e.phase !== "betting" || clock() >= T.dl.bet)
        return reply(false, "No open line to refund.");
      if ((e.actions[uid] || 0) >= lim(T).max_actions)
        return refuse(no("You've reached the action limit this spin.", "E_ACT", { max: lim(T).max_actions }));
      const selected = verb === "clear" ? lines : lines.slice(-1);
      // D2: a removal is checked against the same budget as an admission (a High Roller wheel's: its share too)
      if (!engine.removeOk(engine.lossVector(e.book), selected, (await available(T)).room))
        return refuse(no("🏦 The wheel's bank can't let that line go this spin — it rides.", "E_BANK", { more: 0 }));
      if (clock() >= T.dl.bet) return reply(false, "No more bets — your lines ride.");
      return refund(T, selected, verb, uid, key);
    }
    if (verb === "go") {
      if (e.phase !== "betting" || !lines.length || Object.keys(T.escrowed).length !== 1 || clock() >= T.dl.bet)
        return reply(false, "Only the sole bettor can spin now while bets are open.");
      await draw(T);
      return reply(true, "The wheel is spinning.");
    }
    if (verb === "end") {
      if (T.lobby || (T.host.uid !== uid && !actor.admin))
        return reply(false, T.lobby ? "The lobby wheel stays open." : "Only the wheel's host or an admin may close it.");
      if (e.phase === "result" || e.phase === "spinning" || (e.phase === "betting" && clock() >= T.dl.bet)) {
        T.closing = true;
        await save(T);
        return reply(true, "The wheel will close after this spin.", { quiet: true, pm: false });
      }
      await closeTable(T, "host");
      return reply(true, "Wheel closed.", { quiet: true, pm: false });
    }
    if (verb === "advertise" || verb === "unadvertise") {
      // D4: the lobby wheel is not advertised; a room wheel and a web wheel are, by their host or an admin (advertiseIn)
      if (T.lobby) return reply(false, "The lobby wheel stays on the web — open a room wheel with !rl start.");
      const out = await advertCmd(T, actor, verb, args);
      return { ...out, quiet: out.ok, pm: !out.ok };
    }
    if (verb === "fair")
      return reply(
        true,
        T.last_revealed ? fairLink(T, T.last_revealed) : "The first proof appears after the spin.",
      );
    if (verb === "last")
      return reply(
        true,
        "Last results: " +
          e.history
            .slice(-10)
            .map((x) => x.number)
            .join(", ") +
          ". Each spin is independent.",
      );
    if (verb === "bets")
      return reply(
        true,
        (lines.map((l) => describe(l.bets)).join("; ") || "No bets this spin.") +
          (e.pending[uid] ? " · Queued: " + describe(e.pending[uid].bets) : ""),
      );
    if (verb === "limits") {
      // MONEY-4 / SECURITY-5: the bank's headroom rounded down to the minimum, as a refusal says it (decision 10) - the
      // exact figure would track the worst pocket's liability, other players' chips, to 35 PAT. D3: this spin's limits.
      const a = await available(T),
        L = lim(T),
        room = a.closed ? 0 : bankStraight(T, a.room);
      return reply(
        true,
        (high(T) ? "💎 High Roller wheel · " : "") +
          "Minimum " +
          fmt(L.min) +
          " PAT, straight up to " +
          fmt(room) +
          ", per spin " +
          fmt(L.max_spin) +
          ".",
        { min: L.min, straight: room, max_spin: L.max_spin },
      );
    }
    if (verb === "status")
      return reply(
        true,
        e.phase +
          " · " +
          Math.max(0, Math.ceil(((T.dl.bet || T.dl.land || T.dl.result || clock()) - clock()) / 1000)) +
          "s · " +
          Object.keys(T.escrowed).length +
          " players · " +
          fmt(sum(Object.values(T.escrowed))) +
          " PAT · last: " +
          e.history
            .slice(-5)
            .map((x) => x.number)
            .join(", ") +
          " · " +
          link(T),
      );
    return reply(false, "Use bet, clear, undo, rebet, bets, limits, last, fair, go, status or help.");
  }
  return {
    RC: DEFAULTS,
    start,
    run,
    tick,
    due,
    recover,
    publicView,
    meView,
    lobby,
    openList,
    closeTable,
    ensureLobby,
    openLobby,
    viewShut,
    gate,
    shut,
    restore,
    privateNotes,
    frozenLines,
    bootAudit,
    HELP,
    // 1.99aoj: a wheel's spin limits (D3), its casino-lobby row, the views' cached bank figure, the bank's pure math
    limOf: lim,
    lobbyRow,
    bankRefresh,
    bankRoom,
  };
}
module.exports = { AUDIENCES, DEFAULTS, SETTING_KEYS, POSITIONS, KINDS, checkSetting, readSettings, tierLimits, install };
