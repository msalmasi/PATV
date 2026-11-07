// casino/holdem.js — No-Limit Hold'em tables of the casino backend (1.99lv; docs/casino-backend.md, phase 2).
//
// The same model as blackjack (service.js): a table is one JSON object saved after every change, every PAT movement
// is keyed, and the shared mutex / tick / events / stream slot come from the service core. What's Hold'em's own:
//   * a TABLE SESSION escrow: !sit charges the buy-in (PAT -> chips), !stand / bust / close / idle pays the stack back
//     (chips -> PAT). Within a hand only chips move. Both are journalled as an intent first (crash-safe both ways).
//   * the rake (2% of each contested showdown pot, Pepe's rate) goes to the House by key, after each hand;
//   * PRIVATE hole cards: never in the public view, never in an event. A web player gets their own cards from the
//     per-user state; Pepe gets the cards of the room players at tables in his rooms (bot-only poll) and PMs them;
//   * the next hand's seed is committed while the previous hand ends (or when the table opens) - before any card;
//   * anti-collusion basics: dup-linked or same-address accounts can't sit at one table, and repeated folds to the
//     same opponent are flagged (chip dumping).
// Rules / timers: 60 s to act, then the time bank; timeout checks or folds and keeps the seat (two in a row sit out).
// 15 s between hands, 300 s idle close except sitting-out seats, 9 seats, buy-in 20-200 BB, blinds capped at 5,000/10,000.
// 1.99ov: High Rollers no longer buy in over a table's maximum. Instead, 💎 High Roller TABLES: blinds from the HR_LADDER
// (100K/200K up to 5M/10M; nothing between the normal cap and the ladder) - only High Rollers open them or sit, anyone
// watches.
"use strict";
const H = require("./hmengine");
const fair = require("./fair");
const money = require("./money");
const V = require("./veil");              // 1.99ajw casino2 rework: a veiled player is masked at the table (casino/veil.js)
const sizing = require("./sizing");

const HC = {
  ACT_SECS: 60, NEXT_SECS: 15, IDLE_SECS: 300, MAX_SEATS: 9, MIN_BUY_BB: 20, MAX_BUY_BB: 200, SB_CAP: 5000, BB_CAP: 10000,
  RAKE: 0.02, DUMP_HANDS: 5, DUMP_BB: 50,
  // 1.99ov: the 💎 High Roller table ladder [sb, bb] (Pepe's POKER_HR_LADDER is the same)
  HR_LADDER: [[100000, 200000], [250000, 500000], [500000, 1000000], [1000000, 2000000], [2500000, 5000000], [5000000, 10000000]],
};
const HR_WORDS = ["hr", "high", "highroller", "high-roller", "vip", "💎"];
const HR_ONLY_OPEN = "💎 High Roller tables are for High Rollers (the role is in the prize store — !prizes). Anyone can watch one.";
const HR_ONLY_PLAY = "💎 this is a High Roller table: only High Rollers can sit here (the role is in the prize store — !prizes). You can watch.";
/** "250", "100k", "2.5m", "1,000" -> a whole number (NaN when it isn't one) */
function amt(x) {
  const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(String(x).replace(/,/g, "").trim());
  if (!m) return NaN;
  const v = Number(m[1]) * (m[2] ? (m[2].toLowerCase() === "k" ? 1e3 : 1e6) : 1);
  return Number.isInteger(v) ? v : NaN;
}
const short = (n) => (n >= 1e6 && n % 1e5 === 0 ? `${n / 1e6}M` : n >= 1e3 && n % 100 === 0 ? `${n / 1e3}K` : String(n));
const ladderText = () => HC.HR_LADDER.map(([a, b]) => `${short(a)}/${short(b)}`).join(", ");

function install(core) {
  const { S, clock, save, emit, userRow, isHighRoller, dupOf, R, uidHash, fmt, link, rewards, dropLine, roomsOf, roomList } = core;
  const opKey = (T, uid, op) => `chm:${T.id}:${uid}:${op}:${++T.opno}`;
  const handSpin = (T, n) => `chm:${T.id}:h${n}`;

  function turnFor(e, uid) {
    return { to_call: H.toCall(e, uid), current_bet: e.current_bet,
      min_to: e.current_bet ? e.current_bet + e.min_raise : e.bb,
      max_to: (e.street_paid[uid] || 0) + (e.chips[uid] || 0) };
  }

  function qos(T, uid) {
    T.qol = T.qol || {};
    const q = T.qol[uid] || (T.qol[uid] = { bank: Math.min(setting("hm_timebank_secs", 30), setting("hm_timebank_max", 60)), hands: 0, timeouts: 0, out: false, since: null, back: null });
    T.dl.sitout = T.dl.sitout || {};
    if (q.out && q.since != null) T.dl.sitout[uid] = q.since + setting("hm_sitout_mins", 10) * 60000;
    else delete T.dl.sitout[uid];
    return q;
  }
  const setting = (key, fallback) => Number.isFinite(Number(S.settings[key])) ? Number(S.settings[key]) : fallback;
  function forgetSeat(T, uid) {
    if (T.qol) delete T.qol[uid];
    if (T.dl.sitout) delete T.dl.sitout[uid];
    if (T.pre) delete T.pre[uid];
  }
  // 1.99?? h21 integration: only a seat sitting out holds off the idle close (its own sit-out limit governs it); a returning
  // seat is dealt in whenever the table can deal, so one left alone has nobody to wait for and the 5-minute idle close runs
  const outHolds = (T) => T.eng.seats.some((k) => qos(T, k).out);
  function playable(T) { return H.seatedWithChips(T.eng).filter((uid) => !qos(T, uid).out && qos(T, uid).back !== "wait"); }

  async function sitout(T, actor, back, post) {
    if (!T.eng.seats.includes(actor.uid)) return R(false, "you're not seated at the table.");
    const q = qos(T, actor.uid);
    if (back) {
      if (!q.out && !q.back) return R(true, "you're already playing.");
      q.out = false; q.since = null; q.back = post ? "post" : "wait"; q.timeouts = 0;
      if (!T.eng.hand_active) T.dl.idle = null;
      if (!T.eng.hand_active && !T.dl.next) T.dl.next = clock() + HC.NEXT_SECS * 1000;
    } else {
      if (!q.out) { q.out = true; q.since = clock(); q.back = null; await emit(T, "line", `⏸️ ${T.eng.names[actor.uid]} is sitting out`); }
      if (!T.eng.hand_active && playable(T).length < 2) { T.dl.next = null; T.dl.idle = null; }
    }
    qos(T, actor.uid);
    await save(T);
    return R(true, back ? (post ? "you'll post the big blind next hand." : "waiting for the big blind.") : "sitting out from the next hand.");
  }

  function bankLeft(T, uid) {
    const q = qos(T, uid);
    if (T.turn && T.turn.uid === uid && T.turn.bank_started) return Math.max(0, q.bank - Math.max(0, clock() - T.turn.bank_started) / 1000);
    return q.bank;
  }
  function stopBank(T, uid) {
    qos(T, uid).bank = bankLeft(T, uid);
  }

  // Replay bookkeeping follows the engine's events, never its settlement logic.
  function recordStep(T, ev) {
    const r = T.replay;
    if (!r) return;
    const s = r.state, uid = ev.who;
    let amount = ev.amount || 0, action = ev.t;
    if (ev.t === "blind" || ev.t === "acted") {
      if (ev.t === "acted") {
        action = ev.action;
        if (["raises to","bets","goes all-in"].includes(action)) amount -= s.paid[uid] || 0;
      }
      if (amount) { s.stacks[uid] -= amount; s.paid[uid] = (s.paid[uid]||0)+amount; s.pot += amount; }
    } else if (ev.t === "refund") { s.stacks[uid] += amount; s.pot -= amount; }
    else if (ev.t === "board") { s.board = ev.cards.slice(); s.street = ev.street; s.paid = {}; }
    else if (ev.t === "win_uncontested") { s.stacks[uid] += amount; s.pot -= amount; }
    else if (ev.t === "awards") { for (const a of ev.awards) { s.stacks[a.who] += a.amount; s.pot -= a.amount; } s.pot -= ev.rake; }
    else return;
    r.steps.push({uid:uid||null,action,amount,street:s.street,board:s.board.slice(),pot:s.pot,stacks:Object.assign({},s.stacks)});
  }

  function clearInvalidPre(T) {
    const e = T.eng;
    T.pre = T.pre || {};
    for (const [uid, p] of Object.entries(T.pre)) {
      const owed = H.toCall(e, uid);
      if (!e.hand_active || p.hand !== e.hand_no || p.street !== e.street || e.folded.includes(uid) || e.allin.includes(uid) ||
          (p.kind === "check" && owed !== 0) || (p.kind === "call" && p.amount !== owed)) delete T.pre[uid];
    }
  }

  async function premove(T, actor, kind) {
    const e = T.eng;
    T.pre = T.pre || {};
    kind = ({ checkfold: "check_fold", callany: "call_any" })[kind] || kind;
    if (kind === "off") { delete T.pre[actor.uid]; await save(T); return R(true, "pre-move cleared."); }
    if (!["check_fold", "check", "call", "call_any", "fold"].includes(kind)) return R(false, "pre: check_fold, check, call, call_any, fold or off.");
    if (!e.hand_active || !e.players.includes(actor.uid) || e.folded.includes(actor.uid) || e.allin.includes(actor.uid)) return R(false, "you have no live action in this hand.");
    if (H.currentActor(e) === actor.uid) return R(false, "it's your turn — play your action now.");
    const amount = H.toCall(e, actor.uid);
    if (kind === "check" && amount) return R(false, "check is unavailable while a bet is owed.");
    T.pre[actor.uid] = { kind, amount, hand: e.hand_no, street: e.street };
    await save(T);
    return R(true, "pre-move set.");
  }

  function newTable(host, room, sb, bb, highStakes) {
    const id = require("crypto").randomBytes(5).toString("hex");
    return {
      id, game: "holdem", status: "open", room: room || null, host: { uid: host.uid, name: host.name }, created: clock(),
      client_seed: fair.newClientSeed(), eng: H.newTable({ sb, bb, rake: HC.RAKE }), players: {},
      min_buy: bb * HC.MIN_BUY_BB, max_buy: bb * HC.MAX_BUY_BB, high_stakes: !!highStakes,
      dl: { turn: null, next: null, idle: null }, turn: null, turn_token: 0, next: null, intent: null, rake_due: null,
      opno: 0, multi: [], dump: {}, log: [], last_round: null, rev: 0, closed_at: null, last_activity: clock(),
    };
  }

  // the next hand's seed, committed before any of its cards exist
  async function commitNext(T) {
    const n = T.eng.hand_no + 1;
    const seed = fair.newServerSeed();
    T.next = { no: n, seed, commitment: fair.commitment(seed) };
    await core.runQuery(`INSERT OR REPLACE INTO casino_rounds (table_id, round_no, commitment, client_seed, num_decks, created)
                         VALUES (?, ?, ?, ?, 1, ?)`, [T.id, n, T.next.commitment, T.client_seed, clock()]);
  }

  async function start(actor, room, blinds) {
    let sb = 25, bb = 50;
    if (blinds && HR_WORDS.includes(String(blinds).toLowerCase())) [sb, bb] = HC.HR_LADDER[0];
    else if (blinds) {
      const parts = String(blinds).replace(/[-\\]/g, "/").split("/");
      const a = amt(parts[0]), b = parts.length > 1 ? amt(parts[1]) : NaN;
      if (parts.length > 2 || !Number.isFinite(a) || (parts.length > 1 && !Number.isFinite(b)) || a > 1e9 || b > 1e9) {
        return R(false, "usage: !holdem start <sb>/<bb>  e.g. !holdem start 25/50 (💎 High Rollers: !holdem start 100k/200k)");
      }
      if (parts.length > 1) { sb = a; bb = b; } else { bb = a; sb = Math.max(1, Math.floor(bb / 2)); }
    }
    if (sb < 1 || bb < 2 || sb >= bb) return R(false, "blinds must be positive with small < big, e.g. 25/50.");
    const high = sb > HC.SB_CAP || bb > HC.BB_CAP;
    if (high && !HC.HR_LADDER.some(([s2, b2]) => s2 === sb && b2 === bb)) {
      return R(false, `max blinds are ${fmt(HC.SB_CAP)}/${fmt(HC.BB_CAP)}. 💎 High Roller tables play ${ladderText()}.`);
    }
    if (high && !(await isHighRoller(actor.uid))) return R(false, HR_ONLY_OPEN);
    const T = newTable(actor, room, sb, bb, high);
    S.tables.set(T.id, T);
    V.enter(T, actor);               // 1.99ajw casino2 rework: the opener's "opened" line and the host name follow their veil
    await commitNext(T);
    T.dl.idle = clock() + HC.IDLE_SECS * 1000;
    await save(T);
    await emit(T, "opened", `🃏 ${actor.name} opened a ${high ? "💎 High Roller " : ""}No-Limit Hold'em table — blinds ${fmt(sb)}/${fmt(bb)}. ` +
               `Buy in with !sit <amount> (${fmt(T.min_buy)}–${fmt(T.max_buy)} chips). 2+ players then !holdem deal. Chips = PAT. ` +
               `Play here or on the web: ${link(T)}`, { client_seed: T.client_seed, url: link(T) });
    return R(true, "table open.", { table: T.id, quiet: true });
  }

  async function seatChecks(T, actor) {
    const u = await userRow(actor.uid);
    if (!u) return "no account found";
    if (u.casino_banned) return "🚫 you're banned from the casino.";
    if (T.eng.seats.includes(actor.uid)) return null;
    if (T.eng.seats.length >= HC.MAX_SEATS) return `the table's full (${HC.MAX_SEATS} seats).`;
    const mine = await dupOf(actor.uid);
    for (const k of T.eng.seats) {
      const theirs = await dupOf(k);
      if (k === mine || theirs === actor.uid || (mine && theirs === mine)) return "an account linked to yours is already at this table.";
    }
    // poker is player vs player: two accounts from one address can't sit at the same table
    if (actor.iph && Object.entries(T.players).some(([k, p]) => k !== actor.uid && p.iph === actor.iph && T.eng.seats.includes(k))) {
      T.multi.push({ ts: clock(), a: actor.uid, kind: "same-address refused" });
      return "another account from your connection is already at this table.";
    }
    return null;
  }

  function remember(T, actor) {
    const prev = T.players[actor.uid] || {};
    T.players[actor.uid] = { name: actor.name || prev.name, username: actor.username || prev.username || null,
                             camfrog: actor.camfrog || prev.camfrog || null, via: actor.via || prev.via || "web", iph: actor.iph || prev.iph || null,
                             room: actor.room || prev.room || null };
    V.enter(T, actor, { sitting: true });   // 1.99ajw casino2 rework: a veiled player's seat is masked before any line names them
  }

  async function sit(T, actor, amountArg) {
    const amount = Math.trunc(Number(String(amountArg == null ? "" : amountArg).replace(/,/g, "")));
    if (!Number.isFinite(amount) || amount <= 0) return R(false, `usage: !sit <amount>  (${fmt(T.min_buy)}–${fmt(T.max_buy)} chips)`);
    const bad = await seatChecks(T, actor);
    if (bad) return R(false, bad);
    const e = T.eng;
    const seated = e.seats.includes(actor.uid);
    if (seated && e.hand_active && e.players.includes(actor.uid)) return R(false, "top up between hands — you're in this one.");
    if (T.high_stakes && !(await isHighRoller(actor.uid))) return R(false, HR_ONLY_PLAY);
    if (amount < T.min_buy || amount > T.max_buy) return R(false, `buy-in must be ${fmt(T.min_buy)}–${fmt(T.max_buy)} for these stakes.`);
    if (seated && (e.chips[actor.uid] || 0) + amount > T.max_buy) return R(false, `that would put your stack over the ${fmt(T.max_buy)} max.`);
    remember(T, actor);
    const key = opKey(T, actor.uid, "buy");
    T.intent = { kind: "buy", key, uid: actor.uid, amount, ts: clock() };
    await save(T);
    const r = await money.charge(key, actor.uid, amount, "holdem buy-in");
    if (!r.ok) {
      T.intent = null;
      await save(T);
      if (r.code === "E_INSUFFICIENT") {
        const u = await userRow(actor.uid);
        return R(false, `can't buy in: insufficient PAT (need ${fmt(amount)}, you have ${fmt(u ? u.points_balance : 0)})`);
      }
      return R(false, "can't buy in: charge failed");
    }
    const name = T.players[actor.uid].name;
    H.sit(e, actor.uid, name, amount);
    qos(T, actor.uid);
    T.intent = null;
    if (!e.hand_active) T.dl.idle = clock() + HC.IDLE_SECS * 1000;
    const joining = e.hand_active && !e.players.includes(actor.uid) ? " (joins next hand)" : "";
    await emit(T, "line", `💺 ${name} buys in for ${fmt(amount)} chips${joining}. Stack: ${fmt(e.chips[actor.uid])}.`);
    if (!e.hand_active && H.canStart(e) && !T.dl.next) await emit(T, "line", "Enough players seated — !holdem deal to start the hand.");
    await save(T);
    return R(true, `you bought in for ${fmt(amount)}.`, { quiet: true });
  }

  /** Pay a seat's chips back as PAT and free the seat (intent first: a restart finishes it). */
  async function cashout(T, uid, busted) {
    const e = T.eng;
    if (!e.seats.includes(uid)) return;
    const name = e.names[uid] || (T.players[uid] || {}).name || uid;
    const chips = e.chips[uid] || 0;
    if (chips > 0) {
      const key = opKey(T, uid, "out");
      T.intent = { kind: "out", key, uid, amount: chips, ts: clock() };
      await save(T);
      const r = await money.credit(key, uid, chips, "holdem cash-out");
      if (!r.ok) console.error(`[casino] ${T.id}: cash-out ${chips} to ${uid} failed (${r.code}) - retried at restart`);
    }
    try { H.stand(e, uid); } catch (err) { /* seated in a live hand: the caller made sure it isn't */ }
    forgetSeat(T, uid);
    T.intent = null;
    if (chips > 0) await emit(T, "line", `🚪 ${name} cashes out ${fmt(chips)} PAT.`);
    else if (busted) await emit(T, "line", `💸 ${name} busted out. !sit to rebuy.`);
    else await emit(T, "line", `🚪 ${name} leaves the table.`);
    if (uid === T.host.uid && e.seats.length) {
      const nh = e.seats[0];
      T.host = { uid: nh, name: e.names[nh] || (T.players[nh] || {}).name || nh };
      await emit(T, "line", `👑 ${T.host.name} is now the table host.`);
    }
  }

  async function standCmd(T, actor) {
    const e = T.eng;
    if (!e.seats.includes(actor.uid)) return R(false, "you're not seated at the table.");
    if (e.hand_active && e.players.includes(actor.uid)) {
      H.requestStand(e, actor.uid);
      await save(T);
      return R(true, e.folded.includes(actor.uid) ? "you'll be cashed out when this hand ends."
                                                  : "you'll be cashed out when this hand ends (or !fold to leave sooner).");
    }
    await cashout(T, actor.uid, false);
    if (!e.seats.length) return closeTable(T, "table empty").then(() => R(true, "you left the table.", { quiet: true }));
    if (!e.hand_active && H.seatedWithChips(e).length < 2) T.dl.next = null;      // nobody left to deal to: wait, then close
    if (!e.hand_active && !T.dl.next) T.dl.idle = outHolds(T) ? null : clock() + HC.IDLE_SECS * 1000;
    await save(T);
    return R(true, "you left the table.", { quiet: true });
  }

  async function beginHand(T) {
    const e = T.eng;
    if (e.hand_active || !H.canStart(e)) return false;
    // Keep the complete seat ring. Only the active seat list is passed to startHand;
    // chips, names and escrow ownership are untouched. The engine remains unchanged.
    const seats = e.seats.slice();
    const candidates = H.seatedWithChips(e).filter((uid) => !qos(T, uid).out);
    if (candidates.length < 2) return false;
    // A returning waiter joins only when the clockwise big-blind position reaches them.
    const regular = candidates.filter((uid) => qos(T, uid).back !== "wait");
    let active = regular;
    for (const uid of candidates.filter((k) => qos(T, k).back === "wait")) {
      const trial = candidates.filter((k) => regular.includes(k) || k === uid);
      if (trial.length < 2) continue;
      const button = trial.includes(e.button) ? (trial.indexOf(e.button) + 1) % trial.length : 0;
      if (trial[(button + (trial.length === 2 ? 1 : 2)) % trial.length] === uid) { active = trial; break; }
    }
    // 1.99?? h21 integration: a waiter only waits while a game runs without them. When the seats already playing can't deal a
    // hand on their own (heads-up after a break, everyone back at once), every returning seat is dealt in now - otherwise the
    // table never dealt again and, with its idle close held off, stayed open (and held the room) until someone posted.
    if (active.length < 2) active = candidates;
    T.dl.next = null;
    T.dl.idle = null;
    if (!T.next || T.next.no !== e.hand_no + 1) await commitNext(T);
    const deck = S.hooks.deck ? S.hooks.deck(T, T.next.no) : fair.shuffleShoe(1, T.next.seed, T.client_seed, T.next.no);
    T.hand = { no: T.next.no, seed: T.next.seed, commitment: T.next.commitment, deck };
    T.last_round = null;
    T.last_activity = clock();
    T.replay = { players: active.map((uid) => ({uid,name:V.nameOf(T,uid,e.names[uid]),seat:V.seatOf(T,uid),stack:e.chips[uid]})), steps: [],
      state: {stacks:Object.fromEntries(active.map((uid)=>[uid,e.chips[uid]])),paid:{},pot:0,board:[],street:"preflop"} };
    await core.advertRepeat(T);                       // 1.99pc: a hand is about to start - remind the advertised rooms (rate-limited)
    let events;
    e.seats = active;
    try { events = H.startHand(e, deck); } finally { e.seats = seats; }
    for (const uid of active) {
      const q = qos(T, uid);
      if (q.back === "post" && uid !== e.bb_key && e.hand_active) {
        const amount = Math.min(e.bb - (e.street_paid[uid] || 0), e.chips[uid]);
        if (amount > 0) {
          e.chips[uid] -= amount; e.contrib[uid] += amount; e.street_paid[uid] += amount;
          events.splice(events.findIndex((ev) => ev.t === "deal"), 0, { t: "blind", who: uid, name: e.names[uid], kind: "BB", amount });
          if (!e.chips[uid] && !e.allin.includes(uid)) { e.allin.push(uid); e.need_act = e.need_act.filter((k) => k !== uid); }
        }
      }
      q.back = null;
      q.hands += 1;
      if (q.hands % 10 === 0) q.bank = Math.min(setting("hm_timebank_max", 60), q.bank + setting("hm_timebank_per10", 5));
    }
    // A post-now player with no remaining chips has no turn. H.act's normal
    // check transition advances past that seat without moving any extra chips.
    if (e.actor && e.allin.includes(e.actor)) {
      events = events.filter((ev) => ev.t !== "prompt");
      events.push(...H.act(e, e.actor, H.toCall(e,e.actor) ? "call" : "check", null));
    }
    for (const ev of events) if (ev.t === "prompt") Object.assign(ev, { stack: e.chips[ev.who], to_call: H.toCall(e, ev.who), can_check: H.toCall(e, ev.who) === 0, pot: H.pot(e) });
    await core.runQuery("UPDATE casino_rounds SET dealt = ?, players = ? WHERE table_id = ? AND round_no = ?",
      [clock(), JSON.stringify(e.players.map((k) => ({ uid: k, name: e.names[k], stack: (e.chips[k] || 0) + (e.contrib[k] || 0) }))), T.id, T.hand.no]);
    await render(T, events);
    return true;
  }

  function actedText(ev) {
    const a = ev.action;
    if (a === "bets" || a === "raises to" || a === "goes all-in" || a === "calls" || a === "calls all-in") return `${ev.name} ${a} ${fmt(ev.amount || 0)}`;
    return `${ev.name} ${a}`;
  }

  async function render(T, events) {
    const e = T.eng;
    const winners = new Set(events.filter((ev)=>ev.t==="awards").flatMap((ev)=>ev.awards.map((a)=>a.who)));
    let blinds = [];
    const won = {};                 // 1.99mw: chips each winner took in this step's hand (win XP / gang rep at hand_end)
    for (const ev of events) {
      recordStep(T, ev);
      const t = ev.t;
      if (t === "hand_start") {
        const btn = ev.names[ev.button] || ev.button;
        await emit(T, "hand", `🃏 Hold'em Hand #${ev.hand_no} — dealer button: ${btn}. Blinds ${ev.sb}/${ev.bb}.`, { hand_no: ev.hand_no, commitment: T.hand.commitment });
      } else if (t === "blind") {
        blinds.push(`${ev.name} posts ${ev.kind} ${fmt(ev.amount)}${ev.allin ? " all-in" : ""}`);
      } else if (t === "deal") {
        if (blinds.length) { await emit(T, "line", "🔸 " + blinds.join(" · ")); blinds = []; }
        // the cards themselves are NEVER in an event: Pepe PMs room players from his poll's private part, the web shows each their own
        await emit(T, "deal", "🂠 Hole cards dealt privately — PM in Camfrog, your own seat on the web. !cards resends yours.", { hand_no: e.hand_no });
      } else if (t === "acted") {
        await emit(T, "line", "• " + actedText(ev));
      } else if (t === "refund") {
        await emit(T, "line", `↩️ ${ev.name} takes back ${fmt(ev.amount)} uncalled.`);
      } else if (t === "board") {
        await emit(T, "board", `🂠 ${ev.street.toUpperCase()}: ${H.cardsStr(ev.cards)}  |  Pot ${fmt(ev.pot)}`, { street: ev.street });
      } else if (t === "prompt") {
        clearInvalidPre(T);
        const pre = (T.pre || {})[ev.who];
        if (pre) {
          delete T.pre[ev.who];
          const verb = pre.kind === "check_fold" ? (ev.to_call ? "fold" : "check") :
                       pre.kind === "call_any" ? "call" : pre.kind;
          // Table-only log: no extra room line and no unmasked identity.
          T.log.push({ ts: clock(), text: "auto: " + ({ check: "checked", fold: "folded", call: "called" })[verb] });
          await action(T, { uid: ev.who }, verb, null);
          continue;
        }
        const opts = [ev.can_check ? "!check" : `!call ${fmt(ev.to_call)}`, ev.current_bet > 0 ? `!raise <to ≥${fmt(ev.min_raise_to)}>` : `!bet <≥${fmt(ev.min_raise_to)}>`, "!allin", "!fold"];
        T.turn_token += 1;
        T.turn = { uid: ev.who, hand: e.hand_no, token: T.turn_token };
        T.dl.turn = clock() + HC.ACT_SECS * 1000;
        await emit(T, "prompt", `➡️ @${ev.name} to act — stack ${fmt(ev.stack)}, to call ${fmt(ev.to_call)}, pot ${fmt(ev.pot)}` +
                   `${ev.board.length ? " | Board " + H.cardsStr(ev.board) : ""}.  ${opts.join(" · ")}`, { to: (T.players[ev.who] || {}).camfrog || null });
      } else if (t === "win_uncontested") {
        T.dl.turn = null; T.turn = null;
        // 1.99ajw casino2 rework: the felt's last hand (and casino_rounds.results) is written with a masked player's label + seat id
        T.last_round = { hand_no: e.hand_no, uncontested: true, board: e.board.slice(), shown: [], pot: ev.amount, rake: 0,
                         winners: [{ name: V.nameOf(T, ev.who, ev.name), seat: V.seatOf(T, ev.who), amount: ev.amount, hand: "everyone folded", pot: "pot" }] };
        dumpWatch(T, ev.who);
        // 1.99mw: the site counts every seat (an uncontested pot never drops); the event names nobody for Pepe to award
        await rewards.holdemPot(T, e.hand_no, 0, ev.who, ev.amount, []);
        await rewards.holdemBoardRoyal(T, e.hand_no, [ev.who], e.board);    // 1.99pl: a royal-flush board, everyone else folded
        won[ev.who] = (won[ev.who] || 0) + ev.amount;
        await emit(T, "win", `🏆 ${ev.name} wins ${fmt(ev.amount)} chips — everyone folded.`,
                   { winners: [{ amount: ev.amount }] });
      } else if (t === "showdown") {
        const visible = ev.reveals.filter((r)=>winners.has(r.who) || (T.show || {})[r.who]);
        T.dl.turn = null; T.turn = null;
        T.sd = { board: ev.board.slice(), shown: ev.reveals.map((r) => ({ name: r.name, cards: r.cards.slice(), hand: r.hand, seat: uidHash(r.who) })),
                 cf: ev.reveals.map((r) => ({ uid: r.who, camfrog: (T.players[r.who] || {}).camfrog || null })),
                 // 1.99ajw casino2 rework: what the felt / history show (the event above is Pepe's, for the Camfrog room)
                 pub: visible.map((r) => ({ name: V.nameOf(T, r.who, r.name), cards: r.cards.slice(), hand: r.hand, seat: V.seatOf(T, r.who) })) };
        await emit(T, "showdown", "🃏 SHOWDOWN — " + visible.map((r) => `${r.name} shows ${H.cardsStr(r.cards)} (${r.hand})`).join("; "),
                   { shown: visible.map((r)=>({name:r.name,cards:r.cards.slice(),hand:r.hand,seat:uidHash(r.who)})) });
      } else if (t === "awards") {
        for (const a of ev.awards) await emit(T, "line", `🏆 ${a.name} wins ${fmt(a.amount)} (${a.pot}) with ${a.hand}.`);
        T.last_round = { hand_no: e.hand_no, uncontested: false, board: (T.sd || {}).board || e.board.slice(), shown: (T.sd || {}).pub || (T.sd || {}).shown || [],
                         pot: ev.awards.reduce((s, a) => s + a.amount, 0) + ev.rake, rake: ev.rake,
                         winners: ev.awards.map((a) => ({ name: V.nameOf(T, a.who, a.name), seat: V.seatOf(T, a.who), amount: a.amount, hand: a.hand, pot: a.pot })) };
        if (ev.rake > 0) T.rake_due = { key: `${handSpin(T, e.hand_no)}:rake`, n: e.hand_no, amount: ev.rake };
        // each winner and who they beat at this showdown (the drop's PvP gate)
        const sdcf = T.sd ? T.sd.cf : [];
        // 1.99mw: every pot is counted (and may drop) here, for every seat; the event names nobody for Pepe to award
        const found = [];
        for (const [i, a] of ev.awards.entries()) {
          const d = await rewards.holdemPot(T, e.hand_no, i, a.who, a.amount, sdcf.filter((x) => x.uid !== a.who).map((x) => x.uid));
          if (d) found.push(d);
          won[a.who] = (won[a.who] || 0) + a.amount;
        }
        await rewards.holdemShowdown(T, e.hand_no, T.sd, ev.awards);     // 1.99pa: hand achievements (royal flush, bad beat, ...)
        await emit(T, "awards", "", { rake: ev.rake, winners: ev.awards.map((a) => ({ amount: a.amount })) });
        for (const d of found) await emit(T, "line", dropLine((T.players[d.uid] || {}).name || "someone", d.item));
        T.sd = null;
      } else if (t === "hand_end") {
        // 1.99mw: win XP + gang rep on what each winner took home (chips won - chips put in), once per hand + seat
        if (Object.keys(won).length) await rewards.holdemHand(T, e.hand_no, won, Object.assign({}, e.contrib));
        await save(T);
        await afterHand(T, ev);
      }
    }
  }

  // chip dumping: one player folding to the same opponent again and again with chips in the pot
  function dumpWatch(T, winner) {
    const e = T.eng;
    for (const k of e.folded) {
      const put = e.contrib[k] || 0;
      if (put <= 0 || k === winner) continue;
      const pk = `${k}>${winner}`;
      const d = T.dump[pk] || (T.dump[pk] = { n: 0, chips: 0 });
      d.n += 1; d.chips += put;
      if (d.n >= HC.DUMP_HANDS && d.chips >= HC.DUMP_BB * e.bb && !d.flagged) {
        d.flagged = clock();
        T.multi.push({ ts: clock(), a: k, b: winner, kind: "repeated folds to one player", hands: d.n, chips: d.chips });
        console.warn(`[casino] ${T.id}: ${k} folded ${d.n}x (${d.chips} chips) to ${winner} - flagged`);
      }
    }
  }

  async function bookRake(T) {
    if (!T.rake_due) return;
    const d = T.rake_due;
    await money.house(d.key, handSpin(T, d.n), null, d.amount);       // the rake -> the House, 100%
    T.rake_due = null;
  }

  async function afterHand(T, ev) {
    const e = T.eng;
    await bookRake(T);
    // reveal this hand's seed and deck (the fairness proof), and commit the next one
    if (T.hand) {
      if (T.replay) await require("../dbUtils").tx(() => core.runQuery(`INSERT INTO casino_actions (key,table_id,userId,response,created,replay)
        VALUES (?,?,NULL,'{"ok":false}',?,?) ON CONFLICT(key) DO UPDATE SET replay=excluded.replay`,
        [`hm-replay:${T.id}:${T.hand.no}`,T.id,clock(),JSON.stringify({players:T.replay.players,steps:T.replay.steps})]));
      await core.runQuery("UPDATE casino_rounds SET server_seed = ?, shoe = ?, results = ?, revealed = ? WHERE table_id = ? AND round_no = ?",
                          [T.hand.seed, JSON.stringify(T.hand.deck), JSON.stringify(T.last_round), clock(), T.id, T.hand.no]);
      await emit(T, "reveal", `🔐 Shuffle proof for hand #${T.hand.no}: ${core.fairLink(T, T.hand.no)}`,
                 { round_no: T.hand.no, commitment: T.hand.commitment, server_seed: T.hand.seed, client_seed: T.client_seed });
      T.last_hand_revealed = T.hand.no;
      T.hand = null;
      T.replay = null;
    }
    await commitNext(T);
    for (const k of e.leaving.slice()) await cashout(T, k, false);
    e.leaving = [];
    for (const k of ev.busted || []) if (e.seats.includes(k)) await cashout(T, k, true);
    if (playable(T).length >= 2 || e.seats.some((k) => qos(T, k).back)) {
      T.dl.next = clock() + HC.NEXT_SECS * 1000;
      await emit(T, "line", `Next hand in ${HC.NEXT_SECS}s — !sit to join, !stand to leave, or !holdem deal to start now.`);
    } else if (!e.seats.length) {
      await closeTable(T, "everyone left");
      return;
    } else {
      T.dl.idle = outHolds(T) ? null : clock() + HC.IDLE_SECS * 1000;
      await emit(T, "line", "Need another player with chips — !sit to buy in, then !holdem deal.");
    }
    await save(T);
  }

  async function closeTable(T, reason) {
    const e = T.eng;
    for (const k of e.seats.slice()) await cashout(T, k, false);
    T.status = "closed";
    T.closed_at = clock();
    T.dl = { turn: null, next: null, idle: null };
    T.turn = null;
    await emit(T, "closed", `🃏 Hold'em table closed${reason ? " — " + reason : ""}.`, { reason: reason || null });
    await save(T);
    core.streamGone(T.id);
  }

  async function action(T, actor, verb, amountArg) {
    const e = T.eng;
    if (!e.hand_active) return R(false, "no Hold'em hand in progress.");
    if (!e.players.includes(actor.uid)) return R(false, "you're not in this hand.");
    let amount = null;
    if (verb === "bet" || verb === "raise") {
      const parsed = sizing.parseSize(amountArg, turnFor(e, actor.uid), e.bb, H.pot(e));
      if (parsed.error) return R(false, parsed.error);
      amount = parsed.to;
    }
    let events;
    try {
      events = H.act(e, actor.uid, verb, amount);
    } catch (err) {
      if (!(err instanceof H.PokerError)) throw err;
      return R(false, `🚫 ${err.message}`);
    }
    stopBank(T, actor.uid);
    qos(T, actor.uid).timeouts = 0;
    T.dl.turn = null; T.turn = null;
    if (T.pre) delete T.pre[actor.uid];
    clearInvalidPre(T);
    await render(T, events);
    await save(T);
    return R(true, "ok.", { quiet: true });
  }

  function cardsFor(T, uid) {
    const e = T.eng;
    if (!e.hand_active || !e.hole[uid]) return null;
    return { hand_no: e.hand_no, cards: e.hole[uid].slice(), folded: e.folded.includes(uid) };
  }

  async function cards(T, actor) {
    const c = cardsFor(T, actor.uid);
    if (!c || c.folded) return R(false, "you have no live cards in this hand.");
    return R(true, `🂠 Your hand: ${H.cardsStr(c.cards)} | Board: ${T.eng.board.length ? H.cardsStr(T.eng.board) : "—"}`, { pm: true });
  }

  function statusText(T) {
    const e = T.eng;
    const seats = e.seats.map((k) => `${e.names[k]} (${fmt(e.chips[k])})`);
    let msg = `🃏 Table ${e.sb}/${e.bb} — ${e.hand_active ? "hand in progress" : "waiting for !holdem deal"}. Seats: ` + (seats.join(", ") || "empty");
    if (e.hand_active) msg += ` | Board: ${e.board.length ? H.cardsStr(e.board) : "—"} | Pot ${fmt(H.pot(e))} | To act: ${e.names[H.currentActor(e)] || "—"}`;
    return msg + ` | ${link(T)}`;
  }

  async function end(T, actor) {
    if (actor.uid !== T.host.uid && !actor.admin) return R(false, "only the table starter or an admin can close it.");
    if (T.eng.hand_active) return R(false, "can't close mid-hand — let the hand finish first.");
    await closeTable(T, `closed by ${actor.name}`);
    return R(true, "table closed.", { quiet: true });
  }

  const HELP = "🃏 No-Limit Hold'em — !holdem start <sb>/<bb> opens a table; !sit <amount> buys in; !holdem deal starts a hand. " +
               "On your turn: !check, !call, !bet <n>, !raise <to>, !allin, !fold. Sizing: 3bb, +2bb, 75%, pot, half, min, all. " +
               "!pre check_fold|check|call|call_any|fold|off; !sitout; !sitin [post]. Hole cards arrive by PM (!cards resends). Leave with !stand. " +
               "Losing hands are mucked unless show is selected; the fairness proof still reveals the deck.";

  async function run(T, actor, verb, args) {
    switch (verb) {
      case "pre": return premove(T, actor, String(args[0] || "off").toLowerCase());
      case "sitout": return sitout(T, actor, false, false);
      case "sitin": return sitout(T, actor, true, args[0] === "post");
      case "showhand":
        if (!T.eng.seats.includes(actor.uid)) return R(false, "you're not seated at the table.");
        T.show = T.show || {}; T.show[actor.uid] = args[0] === "1" || args[0] === "on";
        await save(T); return R(true, "show preference saved.");
      case "sit": case "buyin": case "buy": case "join": return sit(T, actor, args[0]);
      case "stand": case "leave": case "cashout": return standCmd(T, actor);
      case "deal": case "next": case "go":
        if (T.eng.hand_active) return R(false, "a hand's already in progress.");
        if (!H.canStart(T.eng)) return R(false, "need 2+ players with chips — !sit to buy in.");
        if (!(await beginHand(T))) return R(false, "need 2 active players; returning players can post the big blind now.");
        await save(T);
        return R(true, "dealing.", { quiet: true });
      case "check": case "call": case "fold": case "allin": case "all-in":
        return action(T, actor, verb === "all-in" ? "allin" : verb, null);
      case "bet": case "raise": return action(T, actor, verb, args[0]);
      case "cards": case "hand": case "hole": return cards(T, actor);
      case "status": case "": case "table": case "info": case "show": return R(true, statusText(T));
      case "end": case "close": case "stop": return end(T, actor);
      case "help": case "rules": case "how": return R(true, HELP);
      case "fair": return R(true, T.last_hand_revealed ? `🔐 Shuffle proof for hand #${T.last_hand_revealed}: ${core.fairLink(T, T.last_hand_revealed)}`
                                                       : `🔐 No hand finished yet — the next hand's commitment is ${T.next ? T.next.commitment.slice(0, 16) + "…" : "pending"}.`);
      default: return R(false, "unknown !holdem option — try: start, sit, deal, stand, status, help.");
    }
  }

  // ── deadlines ──
  async function tick(T) {
    const t = clock(), e = T.eng;
    for (const uid of e.seats.slice()) {
      const q = qos(T, uid);
      if (q.out && q.since != null && t >= T.dl.sitout[uid] && !(e.hand_active && e.players.includes(uid))) {
        await standCmd(T, { uid });
        if (T.status === "closed") return;
      }
    }
    if (T.dl.turn && T.dl.turn <= t) {
      const k = H.currentActor(e);
      if (!k || !T.turn || T.turn.uid !== k || T.turn.hand !== e.hand_no) return;
      const q = qos(T, k);
      if (!T.turn.bank_started && q.bank > 0) {
        T.turn.bank_started = T.dl.turn;
        T.dl.turn += q.bank * 1000;
        await emit(T, "line", `⏰ ${e.names[k]} used their time bank`);
        await save(T);
        if (T.dl.turn > t) return;
      }
      stopBank(T, k);
      T.dl.turn = null;
      q.timeouts += 1;
      if (q.timeouts >= 2) await sitout(T, { uid: k }, false, false);
      const act = H.toCall(e, k) === 0 ? "check" : "fold";
      await emit(T, "line", `⏰ ${e.names[k]} timed out — ${act === "check" ? "checks" : "folds"}.`);
      T.turn = null;
      await render(T, H.act(e, k, act, null));
      clearInvalidPre(T);
      await save(T);
    } else if (T.dl.next && T.dl.next <= t) {
      T.dl.next = null;
      if (!(await beginHand(T))) T.dl.idle = outHolds(T) ? null : clock() + HC.IDLE_SECS * 1000;
      await save(T);
    } else if (T.dl.idle && T.dl.idle <= t) {
      T.dl.idle = null;
      if (e.hand_active) return save(T);
      if (outHolds(T)) return save(T);
      await closeTable(T, "idle — no action");
    }
  }
  const due = (T) => { const t = clock(); return (T.dl.turn && T.dl.turn <= t) || (T.dl.next && T.dl.next <= t) || (T.dl.idle && T.dl.idle <= t) ||
    T.eng.seats.some((uid) => { const q = qos(T, uid); return q.out && q.since != null && t >= T.dl.sitout[uid] && !(T.eng.hand_active && T.eng.players.includes(uid)); }); };

  async function recover(T) {
    const e = T.eng;
    for (const uid of e.seats) qos(T,uid);
    clearInvalidPre(T);
    if (T.intent) {
      const it = T.intent;
      if (it.kind === "buy") {
        // charged but the chips never reached the table: give it back
        if (await money.isDone(it.key)) {
          const r = await money.credit(it.key + ":refund", it.uid, it.amount, "holdem refund (restart)");
          console.log(`[casino] ${T.id}: buy-in ${it.key} interrupted by a restart - refunded (${r.ok ? "ok" : r.code})`);
        }
      } else if (it.kind === "out") {
        // finish the cash-out (the credit is keyed: paid once), then free the seat
        await money.credit(it.key, it.uid, it.amount, "holdem cash-out");
        if (e.seats.includes(it.uid) && !(e.hand_active && e.players.includes(it.uid) && !e.folded.includes(it.uid))) H.stand(e, it.uid);
        if (!e.seats.includes(it.uid)) forgetSeat(T, it.uid);
        console.log(`[casino] ${T.id}: cash-out ${it.key} finished after a restart`);
      }
      T.intent = null;
    }
    await bookRake(T);
    const t = clock();
    if (e.hand_active) {
      const k = H.currentActor(e);
      if (k) {
        const banking = T.turn && T.turn.uid === k && T.turn.bank_started;
        if (banking) stopBank(T, k);
        T.turn = { uid: k, hand: e.hand_no, token: ++T.turn_token };
        if (banking) { T.turn.bank_started = t; T.dl.turn = t + qos(T, k).bank * 1000; }
        else T.dl.turn = t + HC.ACT_SECS * 1000;
      }
    } else {
      if (T.hand) {                                      // the hand ended but its wrap-up didn't run
        await afterHand(T, { busted: e.seats.filter((k) => (e.chips[k] || 0) === 0) });
        return;
      }
      if (T.dl.next && T.dl.next < t + 1000) T.dl.next = t + HC.NEXT_SECS * 1000;
      if (T.dl.idle && T.dl.idle < t + 1000) T.dl.idle = t + HC.IDLE_SECS * 1000;
      if (!T.dl.next && !T.dl.idle && !outHolds(T)) T.dl.idle = t + HC.IDLE_SECS * 1000;
    }
    await save(T);
  }

  // ── views ──
  function publicView(T) {
    const e = T.eng;
    const inHand = e.hand_active ? e.players : [];
    const actor = H.currentActor(e);
    // 1.99ajw casino2 rework (casino/veil.js): a veiled player's seat is masked - its label, its own seat id, veil: 1 (no avatar); the last
    // hand's winners / shown cards match their seat by seat id (two labels can be alike), an older hand by name
    const lr = V.maskRound(T, T.last_round);
    const winners = new Set(((lr || {}).winners || []).map((w) => w.seat || "n:" + w.name));
    const shown = new Map(((lr || {}).shown || []).map((s) => [s.seat, s]));
    const seats = e.seats.map((k) => {
      let status = "waiting";
      if (inHand.includes(k)) status = e.folded.includes(k) ? "folded" : e.allin.includes(k) ? "allin" : "active";
      const seat = V.seatOf(T, k), name = V.nameOf(T, k, e.names[k]);
      const sd = !e.hand_active ? shown.get(seat) : null;
      const p = T.players[k] || {};
      return { name, seat, ...(V.masked(T, k) ? { veil: 1 } : {}), via: V.masked(T, k) ? "web" : p.via || "web", stack: e.chips[k] || 0, bet: e.hand_active ? e.street_paid[k] || 0 : 0,
               sitting_out: qos(T, k).out, waiting_bb: qos(T, k).back === "wait", bank_secs: bankLeft(T, k),
               status, cards_down: inHand.includes(k) && !e.folded.includes(k), button: k === e.button,
               blind: e.hand_active && k === e.sb_key ? "SB" : e.hand_active && k === e.bb_key ? "BB" : null, turn: k === actor,
               leaving: e.leaving.includes(k), host: k === T.host.uid, shown: sd ? sd.cards : null, hand: sd ? sd.hand : null,
               winner: !e.hand_active && (winners.has(seat) || winners.has("n:" + name)) };
    });
    let turn = null;
    if (actor && e.seats.includes(actor)) {
      const paid = e.street_paid[actor] || 0, stack = e.chips[actor] || 0, tc = H.toCall(e, actor);
      turn = { name: V.nameOf(T, actor, e.names[actor]), seat: V.seatOf(T, actor), to_call: tc, can_check: tc === 0, current_bet: e.current_bet,
               min_to: e.current_bet > 0 ? e.current_bet + e.min_raise : e.bb, max_to: paid + stack, paid, can_raise: stack > tc, deadline: T.dl.turn,
               banking: !!(T.turn && T.turn.bank_started) };
    }
    const pots = e.hand_active ? H.buildPots(e.players, e.contrib, e.folded).map((p) => ({ amount: p.amount, players: p.eligible.length })) : [];
    const room = T.room ? S.rooms.get(T.room) : null;
    return {
      id: T.id, game: "holdem", status: T.status, rev: T.rev, room: T.room, room_name: room ? room.name : T.room, rooms: roomList(T), host: V.hostName(T),
      phase: T.status === "closed" ? "closed" : e.hand_active ? H.STREET_NAME[e.street] : "between", hand_no: e.hand_no,
      sb: e.sb, bb: e.bb, min_buy: T.min_buy, max_buy: T.max_buy, high_stakes: T.high_stakes, max_seats: HC.MAX_SEATS, act_secs: HC.ACT_SECS,
      presets_pot: String(S.settings.hm_presets_pot || "33,50,75,100,150").split(",").map(Number),
      presets_bb: String(S.settings.hm_presets_bb || "2.5,3,4").split(",").map(Number),
      adverts: core.advertList(T), rake_pct: HC.RAKE * 100, board: e.board.slice(), pot: H.pot(e), pots, current_bet: e.current_bet, seats, turn,
      next_at: T.dl.next, idle_at: T.dl.idle, client_seed: T.client_seed,
      commitment: e.hand_active && T.hand ? T.hand.commitment : T.next ? T.next.commitment : null,
      commit_round: e.hand_active && T.hand ? T.hand.no : T.next ? T.next.no : null,
      last_round: e.hand_active ? null : lr, last_revealed: T.last_hand_revealed || null, url: link(T),
      log: V.maskLog(T, T.log.slice(-20)),
    };
  }

  async function meView(T, uid, u) {
    const e = T.eng;
    const c = cardsFor(T, uid);
    const actor = H.currentActor(e);
    return {
      // (1.99ajw casino2 rework: a masked seat's own id - the page outlines your seat by it)
      seat: e.seats.includes(uid) ? V.seatOf(T, uid) : null, stack: e.chips[uid] || 0, in_hand: e.hand_active && e.players.includes(uid),
      cards: c ? c.cards : null, folded: c ? c.folded : false, my_turn: actor === uid, leaving: e.leaving.includes(uid),
      pre: (T.pre || {})[uid] || null,
      show_hand: !!(T.show || {})[uid],
      sitting_out: !!(T.qol && T.qol[uid] && T.qol[uid].out), waiting_bb: !!(T.qol && T.qol[uid] && T.qol[uid].back === "wait"), to_call: e.hand_active ? H.toCall(e, uid) : 0,
      host: T.host.uid === uid, high_roller: await isHighRoller(uid),
    };
  }

  // Pepe's private part: the hole cards of room players seated at a table in one of his rooms (never stored in an event)
  function privateFor(T) {
    const e = T.eng, out = {};
    const rooms = roomsOf(T);
    if (!rooms.length || !e.hand_active) return out;
    for (const k of e.players) {
      const p = T.players[k] || {};
      const cf = p.camfrog;
      // 1.99ox: the PM goes out in the room the player plays from (cross-room tables); the home room otherwise
      const room = p.via === "room" && p.room && rooms.includes(p.room) ? p.room : T.room;
      if (cf && !e.folded.includes(k)) out[String(cf).toLowerCase()] = { table: T.id, hand_no: e.hand_no, cards: e.hole[k].slice(), camfrog: cf, room };
    }
    return out;
  }

  const lobbyRow = (T) => ({ game: "holdem", phase: T.eng.hand_active ? H.STREET_NAME[T.eng.street] : "between", players: T.eng.seats.length,
                             max_seats: HC.MAX_SEATS, sb: T.eng.sb, bb: T.eng.bb, min_buy: T.min_buy, max_buy: T.max_buy, hand_no: T.eng.hand_no,
                             high_stakes: T.high_stakes });

  return { HC, start, run, tick, due, recover, publicView, meView, privateFor, lobbyRow, closeTable, cardsFor, HELP,
           midRound: (T) => T.eng.hand_active };
}

module.exports = { install, HC, amt };
