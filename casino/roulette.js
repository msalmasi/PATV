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
  rl_spin_secs: 8,
  rl_result_secs: 5,
  rl_idle_close_mins: 10,
};
const SETTING_KEYS = Object.keys(DEFAULTS);
const caps = ["straight", "split", "street", "corner", "line", "outside"].map((k) => "rl_max_" + k);
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
function checkSetting(key, val, current = DEFAULTS) {
  const value = valueOf(key, val);
  if (!ordered({ ...DEFAULTS, ...current, [key]: value }))
    throw Error("Position limits must be between the minimum bet and the spin maximum.");
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
  return s;
}
const HELP =
  "🛞 Use !rl with a bet and an amount, like red 500, 17 100, or 17-18 100. Try bets, undo, clear, again, limits, last, fair, go or end. !rl go spins a wheel you bet on alone. !spin is the separate prize wheel.";
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
  const reply = (ok, message, extra) => ({ ok, reply: message, pm: true, ...extra });
  const open = () => Array.from(S.tables.values()).filter((t) => t.game === "roulette" && t.status === "open");
  const limits = () =>
    Object.fromEntries(SETTING_KEYS.filter((k) => k !== "casino_roulette").map((k) => [k, S.settings[k]]));
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
      if (!pre)
        await runQuery(
          "INSERT INTO casino_rounds (table_id,round_no,commitment,client_seed,num_decks,created) VALUES (?,?,?,?,0,?)",
          [T.id, n, T.round.commitment, T.client_seed, clock()],
        );
      await save(T);
    });
  }
  async function start(actor, room, lobby = false) {
    const T = {
      id: crypto.randomBytes(5).toString("hex"),
      game: "roulette",
      status: "open",
      room,
      lobby,
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
    if (!lobby)
      await emit(
        T,
        "opened",
        "🛞 " +
          actor.name +
          " opened a roulette wheel — single zero, straight up pays 35 to 1. Bet with !rl and a bet and an amount (!rl help), or on the web: " +
          link(T),
      );
    return reply(true, "Wheel open.", { table: T.id, pm: false, quiet: true });
  }
  // the open lobby wheel, if there is one (no write, no lock)
  const openLobby = () => (S.settings.casino_roulette === "off" ? null : open().find((t) => t.lobby) || null);
  async function ensureLobby() {
    if (S.settings.casino_roulette === "off") return null;
    let T = open().find((t) => t.lobby);
    if (!T) {
      const r = await start({ uid: "house", name: "Pepe" }, null, true);
      T = S.tables.get(r.table);
    }
    return T;
  }
  async function available(T) {
    // (O2) every open wheel's cached book holds its live rows before the shared bank sums them
    for (const t of open()) await hydrate(t);
    if (houseAt === null || houseAt > clock() || houseAt + 5000 <= clock() || T.eng.phase === "idle") {
      houseRead = await money.houseBalance();
      houseAt = clock();
    }
    const floor = require("../funding").state.monetary?.house_hard_floor ?? 5000000;
    const budget = Math.min(
      S.settings.rl_spin_cap,
      Math.floor(((houseRead - floor) * S.settings.rl_bank_pct) / 100),
    );
    const reserved = sum(
      open()
        .filter((t) => t !== T && t.eng.book.length)
        .map((t) => Math.max(0, engine.worst(engine.lossVector(t.eng.book)))),
    );
    return { closed: houseRead <= floor, room: budget - reserved };
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
  async function checkSeat(T, actor) {
    const uid = actor.uid,
      e = T.eng;
    if (!e.seats.includes(uid)) {
      if (Object.keys(T.veil || {}).length >= 35 && !(T.veil || {})[uid])
        return T.lobby
          ? "This wheel is full for now — a fresh one opens after this spin."
          : "This wheel is full — it closes after this spin, then !rl start opens a new one.";
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
  function capFor(b) {
    const k = { trio: "street", first_four: "corner" }[b.kind] || b.kind;
    return S.settings["rl_max_" + k] || S.settings.rl_max_outside;
  }
  // The per-position, position-count and per-spin limits of a line on top of the player's lines (none for a queued
  // line: it opens the player's next spin). -> {why} | {amounts: token -> the player's total on it}
  function lineLimits(bets, lines, web) {
    const s = S.settings,
      amounts = new Map();
    for (const b of lines.flatMap((l) => l.bets)) amounts.set(b.token, (amounts.get(b.token) || 0) + b.amount);
    for (const b of bets) {
      const amount = (amounts.get(b.token) || 0) + b.amount;
      if (!Number.isSafeInteger(b.amount) || b.amount < s.rl_min_bet || amount > capFor(b))
        return { why: "The limit on " + label(b.token, web) + " is " + fmt(capFor(b)) + " PAT, minimum " + fmt(s.rl_min_bet) + "." };
      amounts.set(b.token, amount);
    }
    if (amounts.size > s.rl_max_positions || sum([...amounts.values()]) > s.rl_max_spin)
      return { why: "That line exceeds your per-spin limit." };
    return { amounts };
  }
  async function checkLine(T, actor, bets) {
    const s = S.settings,
      e = T.eng,
      uid = actor.uid;
    if (!own(T, uid).length && Object.keys(T.escrowed).length >= s.rl_max_players)
      return "The wheel has reached its player limit.";
    if ((e.actions[uid] || 0) >= s.rl_max_lines) return "You've reached the action limit this spin.";
    const limited = lineLimits(bets, own(T, uid), actor.via === "web");
    if (limited.why) return limited.why;
    const { closed, room } = await available(T);
    if (closed) return "The wheel's bank is closed right now.";
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
          capFor(b) - (limited.amounts.get(b.token) - b.amount),
          s.rl_max_spin - (total - b.amount),
        );
        more = Math.floor(head / s.rl_min_bet) * s.rl_min_bet;
        if (more < s.rl_min_bet || engine.worst(engine.lossVector(rest.concat({ uid, bets: [{ ...b, amount: more }] }))) > room)
          more = 0;
      }
      const token = (b || bets[0]).token;
      return more > 0
        ? "🏦 The wheel can take at most " + fmt(more) + " more on " + token + " this spin."
        : "🏦 The wheel can't take more on " + token + " this spin.";
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
    if (why) return reply(false, why);
    if (T.closing || copyOf(T)) return reply(false, "🛞 This wheel closes after this spin — no new bets.");
    const e = T.eng,
      uid = actor.uid;
    if (["result", "spinning"].includes(e.phase)) {
      // A queued line is checked now as far as it can be (ENGINE-4 / SUITES-2): a room wheel that closes after this spin
      // opens no next spin, and the limits and the balance refuse it now with the reason. The bank and a balance spent
      // meanwhile are checked when betting opens; a refusal then is told privately (queuedLines).
      if (!T.lobby && rotation(T))
        return reply(false, "🛞 This wheel closes after this spin — no new bets. !rl start opens a new one then.");
      if (!e.pending[uid] && Object.keys(e.pending).length >= S.settings.rl_max_players)
        return reply(false, "The next spin is full.");
      const limited = lineLimits(bets, [], actor.via === "web");
      if (limited.why) return reply(false, limited.why);
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
    if (blocked) return reply(false, blocked);
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
  async function closeTable(T, reason) {
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
        await emit(T, "closed", CLOSED[reason] || "🛞 The roulette wheel closed.", { reason });
        await save(T);
      });
    } catch (err) {
      await restore(T); // (the wheel stays open with its close owed: the next tick or boot resumes it)
      throw err;
    }
    streamGone(T.id);
  }
  const CLOSED = {
    full: "🛞 The roulette wheel closed: it reached 35 players. !rl start opens a new one.",
    rotated: "🛞 This lobby wheel closed; a fresh one is open.",
  };
  const rotation = (T) =>
    Object.keys(T.veil || {}).length >= 35 || (T.lobby && clock() - T.created >= 86400000);
  async function advance(T) {
    const off = S.settings.casino_roulette === "off";
    if (T.closing || off || rotation(T)) {
      // ENGINE-4: the lobby rotates (a day, or 35 people) - its queued lines move to the fresh lobby wheel and are
      // charged when its window opens; its page follows the successor (publicView next_table)
      const carry = T.lobby && !T.closing && !off ? T.eng.pending : {};
      if (Object.keys(carry).length) T.eng.pending = {};
      await closeTable(T, T.closing || off ? "wheel finished" : T.lobby ? "rotated" : "full");
      if (T.lobby && T.status === "closed" && !off) await succeed(T, carry);
      return;
    }
    await nextSeed(T);
    await queuedLines(T);
  }
  async function succeed(T, carry) {
    let N = null;
    try {
      N = await ensureLobby();
    } catch (e) {
      console.error("[casino] the next lobby wheel:", e.message);
    }
    if (!N || N === T) {
      for (const [uid, line] of Object.entries(carry)) tell(T, uid, line.bets, "the wheel closed.");
      await save(T);
      return;
    }
    for (const [uid, line] of Object.entries(carry)) {
      N.players[uid] = N.players[uid] || T.players[uid];
      N.eng.pending[uid] = line;
    }
    if (Object.keys(carry).length) await save(N);
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
  function publicView(T) {
    const e = T.eng;
    return {
      id: T.id,
      game: "roulette",
      status: T.status,
      rev: T.rev,
      lobby: T.lobby,
      host: T.lobby ? "Pepe" : V.hostName(T),
      rooms: roomList(T),
      room: T.room,
      url: link(T),
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
      seats: e.seats.map((uid) => ({
        name: V.nameOf(T, uid, T.players[uid].name),
        seat: V.seatOf(T, uid),
        host: uid === T.host.uid,
        staked: T.escrowed[uid] || 0,
        ...(V.masked(T, uid) ? { veil: 1 } : {}),
      })),
      totals: { players: Object.keys(T.escrowed).length, staked: sum(Object.values(T.escrowed)) },
      history: e.history.slice(),
      last_round: V.maskRound(T, T.last_round),
      limits: limits(),
      log: V.maskLog(T, T.log),
    };
  }
  // The one-time intro notice is taken (a write: casino_notice_seen) only when the caller will show it - the table page's
  // and the Room Dock's first request ask with ?notice=1; their 1-2 s polls are reads.
  async function meView(T, uid, opts = {}) {
    return {
      host: !T.lobby && T.host.uid === uid,
      lines: own(T, uid).map((l) => ({ text: describe(l.bets), amount: l.amount })),
      staked: T.escrowed[uid] || 0,
      pending: T.eng.pending[uid] ? describe(T.eng.pending[uid].bets) : null,
      last_slip: lastSlip(T, uid) ? describe(lastSlip(T, uid)) : null,
      room_left: Math.max(0, S.settings.rl_max_spin - (T.escrowed[uid] || 0)),
      net: T.eng.net?.[uid] ?? null,
      private_note: T.eng.notes?.[uid] || null,
      notice: opts.notice ? await require("./notices").take("rl_intro", uid, clock(), S.settings) : null,
    };
  }
  function openList() {
    return open().map((T) => ({
      id: T.id,
      url: link(T),
      rooms: roomsOf(T),
      room_name: roomList(T)[0]?.name || null,
      players: T.eng.seats.length,
      phase: T.eng.phase,
      lobby: T.lobby,
    }));
  }
  async function lobby(uid) {
    const on = !(await shut({ uid }));
    const wheels = on ? openList() : [];
    return { on, lobby: wheels.find((w) => w.lobby) || null, wheels };
  }
  async function run(actor, verb, args, opts) {
    const T = opts.table && S.tables.get(opts.table);
    if (verb === "start") {
      const why = await gate(actor);
      if (why) return reply(false, why);
      if (actor.via !== "room" || !opts.room)
        return reply(false, "Open room wheels with !rl start in the room.");
      return cmdStart(actor, opts.room, "roulette");
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
          : grammar.parse(args[0], { maxPairs: actor.via === "web" ? 20 : 6, minBet: S.settings.rl_min_bet });
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
      if ((e.actions[uid] || 0) >= S.settings.rl_max_lines)
        return reply(false, "You've reached the action limit this spin.");
      const selected = verb === "clear" ? lines : lines.slice(-1);
      if (!engine.removeOk(engine.lossVector(e.book), selected, (await available(T)).room))
        return reply(false, "🏦 The wheel's bank can't let that line go this spin — it rides.");
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
        return reply(false, "Only a room wheel's host or an admin may close it.");
      if (e.phase === "result" || e.phase === "spinning" || (e.phase === "betting" && clock() >= T.dl.bet)) {
        T.closing = true;
        await save(T);
        return reply(true, "The wheel will close after this spin.", { quiet: true, pm: false });
      }
      await closeTable(T, "host");
      return reply(true, "Wheel closed.", { quiet: true, pm: false });
    }
    if (verb === "advertise" || verb === "unadvertise") {
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
      const a = await available(T),
        min = S.settings.rl_min_bet;
      // MONEY-4 / SECURITY-5: the bank's headroom rounded down to the minimum, as a refusal says it (decision 10) - the
      // exact figure would track the worst pocket's liability, other players' chips, to 35 PAT
      const bank = Math.min(
        ...Array.from({ length: 37 }, (_, p) => engine.maxMore(engine.lossVector(e.book), engine.positions[p], a.room)),
      );
      const room = Math.max(0, Math.min(S.settings.rl_max_straight, Math.floor(bank / min) * min));
      return reply(
        true,
        "Minimum " +
          fmt(S.settings.rl_min_bet) +
          " PAT, straight up to " +
          fmt(room) +
          ", per spin " +
          fmt(S.settings.rl_max_spin) +
          ".",
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
  };
}
module.exports = { AUDIENCES, DEFAULTS, SETTING_KEYS, checkSetting, readSettings, install };
