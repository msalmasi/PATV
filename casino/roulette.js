// Roulette tables share the casino mutex, ledger, veil and clock with the card tables.
"use strict";
const crypto = require("crypto");
const fair = require("./fair");
const money = require("./money");
const engine = require("./rlengine");
const grammar = require("./rlbets");
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
const describe = (bets) => bets.map((b) => grammar.token(b) + " " + b.amount).join(" · ");
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
    " · dozen " +
    Math.ceil(p / 12) +
    " · column " +
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
  // Journalled operations may fail after an in-memory edit but before the SQLite transaction commits.
  // Load the durable book before the next admission, tick or refund observes that edit.
  async function restore(T) {
    if (!T) return;
    const row = (await getQuery("SELECT state FROM casino_tables WHERE id=?", [T.id]))[0];
    if (!row) return;
    adopt(T, JSON.parse(row.state));
  }
  function pruneInactive(T) {
    const e = T.eng;
    e.seats = e.seats.filter((uid) => own(T, uid).length || e.pending[uid] || clock() - e.seen[uid] < 600000);
  }
  async function nextSeed(T) {
    const n = T.eng.round_no + 1,
      seed = fair.newServerSeed();
    await tx(async () => {
      T.round = { seed, commitment: fair.commitment(seed), no: n };
      T.eng.round_no = n;
      T.eng.phase = "idle";
      T.eng.book = [];
      pruneInactive(T);
      T.eng.actions = {};
      T.dl = {};
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
  function lastSlip(T, uid) {
    const lines = own(T, uid);
    return T.eng.phase === "spinning" && lines.length ? combinedSlip(lines) : T.eng.lastslip[uid] || null;
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
  function lineLimits(bets, lines) {
    const s = S.settings,
      amounts = new Map();
    for (const b of lines.flatMap((l) => l.bets)) amounts.set(b.token, (amounts.get(b.token) || 0) + b.amount);
    for (const b of bets) {
      const amount = (amounts.get(b.token) || 0) + b.amount;
      if (!Number.isSafeInteger(b.amount) || b.amount < s.rl_min_bet || amount > capFor(b))
        return { why: "The limit on " + b.token + " is " + fmt(capFor(b)) + " PAT, minimum " + fmt(s.rl_min_bet) + "." };
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
    const limited = lineLimits(bets, own(T, uid));
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
  async function saveAnswer(T, out, uid, key) {
    await tx(async () => {
      await save(T);
      if (key)
        await runQuery(
          "INSERT OR IGNORE INTO casino_actions (key,table_id,userId,response,created) VALUES (?,?,?,?,?)",
          [key, T.id, uid, JSON.stringify(out), clock()],
        );
    });
    return out;
  }
  async function place(T, actor, bets, key, queued = false) {
    const why = (await gate(actor)) || (await checkSeat(T, actor));
    if (why) return reply(false, why);
    if (T.closing) return reply(false, "🛞 This wheel closes after this spin — no new bets.");
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
      const limited = lineLimits(bets, []);
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
          (previous ? "Replaced your queued line: " : "Queued for the next spin: ") +
            describe(bets) +
            " (charged when betting opens).",
        ),
        uid,
        key,
      );
    }
    const blocked = await checkLine(T, actor, bets);
    if (blocked) return reply(false, blocked);
    if (e.phase === "betting" && clock() >= T.dl.bet)
      return reply(false, "No more bets — wait for the next spin.");
    const amount = amountOf(bets),
      line = { uid, bets, amount, key: spinKey(T) + ":" + uid + ":b" + ++T.opno };
    T.intent = { key: line.key, uid, amount };
    await save(T);
    crash("intent");
    const charge = await money.charge(line.key, uid, amount, "roulette bet");
    if (!charge.ok) {
      T.intent = null;
      await save(T);
      return reply(false, "The stake could not be charged. Check your available PAT.");
    }
    crash("charge");
    seat(T, actor);
    e.book.push(line);
    T.stakes.push({ key: line.key, uid, amount });
    T.escrowed[uid] = (T.escrowed[uid] || 0) + amount;
    T.intent = null;
    e.actions[uid] = (e.actions[uid] || 0) + 1;
    T.last_activity = clock();
    if (e.notes) delete e.notes[uid];
    if (queued) delete e.pending[uid];
    const first = e.phase === "idle";
    if (first) {
      e.phase = "betting";
      T.dl.bet = clock() + S.settings.rl_bet_secs * 1000;
    }
    const ans = reply(
      true,
      "✅ On the wheel: " +
        describe(bets) +
        " — " +
        fmt(T.escrowed[uid]) +
        " PAT on this spin from you (spins in " +
        Math.ceil((T.dl.bet - clock()) / 1000) +
        "s).",
    );
    await saveAnswer(T, ans, uid, key);
    if (first) {
      const rooms = roomsOf(T).filter((id) => annDue(T, "open_ts", id));
      if (rooms.length) {
        await emit(T, "line", "🛞 Bets are open.", { rooms });
        await save(T);
      }
    }
    return ans;
  }
  function dropLines(T, keys) {
    T.eng.book = T.eng.book.filter((l) => !keys.includes(l.key));
    T.stakes = T.stakes.filter((l) => !keys.includes(l.key));
    T.escrowed = {};
    for (const l of T.eng.book) T.escrowed[l.uid] = (T.escrowed[l.uid] || 0) + l.amount;
  }
  async function finishRefund(T) {
    const it = T.intent,
      keys = it.refund;
    for (const l of T.stakes.filter((l) => keys.includes(l.key))) {
      const result = await money.credit(l.key + ":refund", l.uid, l.amount, "roulette refund (" + it.why + ")");
      if (!result.ok) throw Error("Wheel refund pending");
      crash("refund");
    }
    dropLines(T, keys);
    T.intent = null;
    if (it.uid) T.eng.actions[it.uid] = (T.eng.actions[it.uid] || 0) + 1;
    if (it.why === "clear") delete T.eng.pending[it.uid];
    if (!T.eng.book.length && T.eng.phase === "betting") {
      T.eng.phase = "idle";
      T.dl = {};
    }
    return saveAnswer(T, reply(true, "Refunded " + fmt(it.amount) + " PAT."), it.uid, it.actKey);
  }
  async function refund(T, lines, why, uid, key) {
    T.intent = {
      refund: lines.map((l) => l.key),
      amount: sum(lines.map((l) => l.amount)),
      why,
      uid,
      actKey: key,
    };
    await save(T);
    return finishRefund(T);
  }
  async function discardRefunded(T) {
    const keys = [];
    for (const l of T.eng.book) if (await money.isDone(l.key + ":refund")) keys.push(l.key);
    if (keys.length) {
      dropLines(T, keys);
      await save(T);
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
    const r = { ...T.round, pocket: fair.spinPocket(T.round.seed, T.client_seed, T.round.no) },
      dl = { land: clock() + S.settings.rl_spin_secs * 1000 },
      next = { ...T, round: r, eng: { ...T.eng, phase: "spinning" }, dl };
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
    });
    Object.assign(T, { round: r, dl, rev: next.rev, updated: next.updated });
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
  async function land(T) {
    await discardRefunded(T);
    const e = T.eng,
      r = T.round,
      key = spinKey(T),
      p = r.pocket;
    const results = engine.settle(e.book, p);
    r.results = results;
    r.settle = "pending";
    await save(T);
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
    houseAt = null;
    crash("house-");
    try {
      await require("./rewards").rouletteSpin(T, r.no, results, p);
    } catch (e) {
      // Reward outages have no bearing on a completed PAT settlement.
      console.error("[casino] roulette rewards:", e.message);
    }
    crash("rewards");
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
    await tx(async () => {
      await runQuery(
        "UPDATE casino_rounds SET shoe=?,results=?,server_seed=?,revealed=? WHERE table_id=? AND round_no=?",
        [JSON.stringify({ pocket: p, pockets: 37 }), JSON.stringify(last), r.seed ?? null, clock(), T.id, r.no],
      );
      crash("round");
      for (const uid of Object.keys(results)) e.lastslip[uid] = combinedSlip(own(T, uid));
      T.last_round = last;
      e.net = Object.fromEntries(Object.entries(results).map(([u, x]) => [u, x.net]));
      e.history = e.history.concat({ round_no: r.no, number: p, color: last.color }).slice(-20);
      T.last_activity = clock();
      T.last_revealed = r.no;
      T.escrowed = {};
      T.stakes = [];
      e.book = [];
      r.settle = "done";
      e.phase = "result";
      T.dl = { result: clock() + S.settings.rl_result_secs * 1000 };
      await emit(T, "result", text);
      await save(T);
    });
  }
  async function closeTable(T, reason) {
    if (T.status !== "open") return;
    if (T.eng.phase === "spinning") {
      T.closing = true;
      await save(T);
      return;
    }
    // Bets stop (committed) before anything is revealed: a reader can see the unused seed while the reveal's
    // transaction is open, and a reveal that fails must leave a wheel that takes no bet on that round.
    if (!T.closing) {
      T.closing = true;
      await save(T);
    }
    if (T.eng.book.length) await refund(T, T.eng.book, "end", null, null);
    await tx(async () => {
      if (!T.round.settle)
        await runQuery(
          "UPDATE casino_rounds SET server_seed=?,shoe=?,revealed=? WHERE table_id=? AND round_no=?",
          [
            T.round.seed,
            JSON.stringify({ pocket: fair.spinPocket(T.round.seed, T.client_seed, T.round.no), pockets: 37 }),
            clock(),
            T.id,
            T.round.no,
          ],
        );
      T.last_revealed = T.round.no;
      T.status = "closed";
      T.closed_at = clock();
      T.dl = {};
      for (const [uid, line] of Object.entries(T.eng.pending)) tell(T, uid, line.bets, "the wheel closed.");
      T.eng.pending = {};
      await emit(T, "closed", CLOSED[reason] || "🛞 The roulette wheel closed.", { reason });
      await save(T);
    });
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
    if (T.intent) return recover(T);
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
  async function finishIntent(T) {
    if (T.intent?.refund) await finishRefund(T);
    else if (T.intent) {
      const it = T.intent;
      if (await money.isDone(it.key)) {
        const paid = await money.credit(it.key + ":refund", it.uid, it.amount, "roulette refund (restart)");
        if (!paid.ok) throw Error("Stake recovery pending");
      }
      T.intent = null;
      await save(T);
    }
  }
  // FAIR-1 (1.99aoe): a wheel copied from another database - deploy/keep-staging-tables.js strips an open wheel's secret
  // seed from a staging copy and marks it `copied`. That database's wheel may still take bets on this very round (the
  // lobby can wait a day for its first bet), so the copy is never played or revealed here: a drawn spin's keyed payouts
  // finish (its pocket was already shown there), every line on its book is refunded, and it closes with its commitment
  // unrevealed.
  async function retireCopy(T) {
    await finishIntent(T);
    if (T.round?.settle === "pending") await land(T);
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
    if (T.copied || (T.round && !T.round.seed)) return retireCopy(T);
    await finishIntent(T);
    if (T.eng.phase === "betting" && T.dl.bet <= clock()) {
      T.dl.bet = clock() + S.settings.rl_bet_secs * 1000;
      await save(T);
    }
    if (T.round?.settle === "pending") return land(T);
    if (T.eng.phase === "idle" || T.eng.phase === "betting") await queuedLines(T);
    if (due(T)) await tick(T);
  }
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
      last_revealed: T.last_revealed,
      deadline: T.dl.bet || null,
      land_at: T.dl.land || null,
      result_until: T.dl.result || null,
      spin:
        e.phase === "spinning"
          ? {
              round_no: e.round_no,
              number: T.round.pocket,
              color: engine.color(T.round.pocket),
              ends_at: T.dl.land,
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
      if (T.lobby) return reply(false, "The lobby wheel stays on the web.");
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
    gate,
    shut,
    restore,
    privateNotes,
    HELP,
  };
}
module.exports = { AUDIENCES, DEFAULTS, SETTING_KEYS, checkSetting, readSettings, install };
