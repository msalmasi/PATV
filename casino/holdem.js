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
// Rules / timers / texts are Pepe's !holdem (frida-bot.py _poker_*): 60 s to act (time-out = check, or fold and sit
// out), 15 s between hands, 300 s idle close, 9 seats, buy-in 20-200 big blinds, blinds capped at 5,000/10,000.
// 1.99ov: High Rollers no longer buy in over a table's maximum. Instead, 💎 High Roller TABLES: blinds from the HR_LADDER
// (100K/200K up to 5M/10M; nothing between the normal cap and the ladder) - only High Rollers open them or sit, anyone
// watches.
"use strict";
const H = require("./hmengine");
const fair = require("./fair");
const money = require("./money");

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
    if (!e.hand_active && !T.dl.next) T.dl.idle = clock() + HC.IDLE_SECS * 1000;
    await save(T);
    return R(true, "you left the table.", { quiet: true });
  }

  async function beginHand(T) {
    const e = T.eng;
    if (e.hand_active || !H.canStart(e)) return false;
    T.dl.next = null;
    T.dl.idle = null;
    if (!T.next || T.next.no !== e.hand_no + 1) await commitNext(T);
    const deck = S.hooks.deck ? S.hooks.deck(T, T.next.no) : fair.shuffleShoe(1, T.next.seed, T.client_seed, T.next.no);
    T.hand = { no: T.next.no, seed: T.next.seed, commitment: T.next.commitment, deck };
    T.last_round = null;
    T.last_activity = clock();
    const events = H.startHand(e, deck);
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
    let blinds = [];
    const won = {};                 // 1.99mw: chips each winner took in this step's hand (win XP / gang rep at hand_end)
    for (const ev of events) {
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
        const opts = [ev.can_check ? "!check" : `!call ${fmt(ev.to_call)}`, ev.current_bet > 0 ? `!raise <to ≥${fmt(ev.min_raise_to)}>` : `!bet <≥${fmt(ev.min_raise_to)}>`, "!allin", "!fold"];
        T.turn_token += 1;
        T.turn = { uid: ev.who, hand: e.hand_no, token: T.turn_token };
        T.dl.turn = clock() + HC.ACT_SECS * 1000;
        await emit(T, "prompt", `➡️ @${ev.name} to act — stack ${fmt(ev.stack)}, to call ${fmt(ev.to_call)}, pot ${fmt(ev.pot)}` +
                   `${ev.board.length ? " | Board " + H.cardsStr(ev.board) : ""}.  ${opts.join(" · ")}`, { to: (T.players[ev.who] || {}).camfrog || null });
      } else if (t === "win_uncontested") {
        T.dl.turn = null; T.turn = null;
        T.last_round = { hand_no: e.hand_no, uncontested: true, board: e.board.slice(), shown: [], pot: ev.amount, rake: 0,
                         winners: [{ name: ev.name, amount: ev.amount, hand: "everyone folded", pot: "pot" }] };
        dumpWatch(T, ev.who);
        // 1.99mw: the site counts every seat (an uncontested pot never drops); the event names nobody for Pepe to award
        await rewards.holdemPot(T, e.hand_no, 0, ev.who, ev.amount, []);
        won[ev.who] = (won[ev.who] || 0) + ev.amount;
        await emit(T, "win", `🏆 ${ev.name} wins ${fmt(ev.amount)} chips — everyone folded.`,
                   { winners: [{ amount: ev.amount }] });
      } else if (t === "showdown") {
        T.dl.turn = null; T.turn = null;
        T.sd = { board: ev.board.slice(), shown: ev.reveals.map((r) => ({ name: r.name, cards: r.cards.slice(), hand: r.hand, seat: uidHash(r.who) })),
                 cf: ev.reveals.map((r) => ({ uid: r.who, camfrog: (T.players[r.who] || {}).camfrog || null })) };
        await emit(T, "showdown", "🃏 SHOWDOWN — " + ev.reveals.map((r) => `${r.name} shows ${H.cardsStr(r.cards)} (${r.hand})`).join("; "),
                   { shown: T.sd.shown });
      } else if (t === "awards") {
        for (const a of ev.awards) await emit(T, "line", `🏆 ${a.name} wins ${fmt(a.amount)} (${a.pot}) with ${a.hand}.`);
        T.last_round = { hand_no: e.hand_no, uncontested: false, board: (T.sd || {}).board || e.board.slice(), shown: (T.sd || {}).shown || [],
                         pot: ev.awards.reduce((s, a) => s + a.amount, 0) + ev.rake, rake: ev.rake,
                         winners: ev.awards.map((a) => ({ name: a.name, amount: a.amount, hand: a.hand, pot: a.pot })) };
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
        await rewards.holdemShowdown(T, e.hand_no, T.sd, ev.awards);     // 1.99oy: hand achievements (royal flush, bad beat, ...)
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
      await core.runQuery("UPDATE casino_rounds SET server_seed = ?, shoe = ?, results = ?, revealed = ? WHERE table_id = ? AND round_no = ?",
                          [T.hand.seed, JSON.stringify(T.hand.deck), JSON.stringify(T.last_round), clock(), T.id, T.hand.no]);
      await emit(T, "reveal", `🔐 Shuffle proof for hand #${T.hand.no}: ${core.fairLink(T, T.hand.no)}`,
                 { round_no: T.hand.no, commitment: T.hand.commitment, server_seed: T.hand.seed, client_seed: T.client_seed });
      T.last_hand_revealed = T.hand.no;
      T.hand = null;
    }
    await commitNext(T);
    for (const k of e.leaving.slice()) await cashout(T, k, false);
    e.leaving = [];
    for (const k of ev.busted || []) if (e.seats.includes(k)) await cashout(T, k, true);
    if (H.seatedWithChips(e).length >= 2) {
      T.dl.next = clock() + HC.NEXT_SECS * 1000;
      await emit(T, "line", `Next hand in ${HC.NEXT_SECS}s — !sit to join, !stand to leave, or !holdem deal to start now.`);
    } else if (!e.seats.length) {
      await closeTable(T, "everyone left");
      return;
    } else {
      T.dl.idle = clock() + HC.IDLE_SECS * 1000;
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
    if (amountArg != null && amountArg !== "") {
      amount = Math.trunc(Number(String(amountArg).replace(/,/g, "")));
      if (!Number.isFinite(amount)) amount = null;
    }
    let events;
    try {
      events = H.act(e, actor.uid, verb, amount);
    } catch (err) {
      if (!(err instanceof H.PokerError)) throw err;
      return R(false, `🚫 ${err.message}`);
    }
    T.dl.turn = null; T.turn = null;
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
               "On your turn: !check, !call, !bet <n>, !raise <to>, !allin, !fold. Hole cards arrive by PM (!cards resends). Leave with !stand.";

  async function run(T, actor, verb, args) {
    switch (verb) {
      case "sit": case "buyin": case "buy": case "join": return sit(T, actor, args[0]);
      case "stand": case "leave": case "cashout": return standCmd(T, actor);
      case "deal": case "next": case "go":
        if (T.eng.hand_active) return R(false, "a hand's already in progress.");
        if (!H.canStart(T.eng)) return R(false, "need 2+ players with chips — !sit to buy in.");
        await beginHand(T);
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
    if (T.dl.turn && T.dl.turn <= t) {
      T.dl.turn = null;
      const k = H.currentActor(e);
      if (!k || !T.turn || T.turn.uid !== k || T.turn.hand !== e.hand_no) return;
      const act = H.toCall(e, k) === 0 ? "check" : "fold";
      await emit(T, "line", `⏰ ${e.names[k]} timed out — ${act === "check" ? "checks" : "folds"}.`);
      if (act === "fold") H.requestStand(e, k);            // AFK on a live bet: sat out after the hand
      T.turn = null;
      await render(T, H.act(e, k, act, null));
      await save(T);
    } else if (T.dl.next && T.dl.next <= t) {
      T.dl.next = null;
      if (!(await beginHand(T))) T.dl.idle = clock() + HC.IDLE_SECS * 1000;
      await save(T);
    } else if (T.dl.idle && T.dl.idle <= t) {
      T.dl.idle = null;
      if (e.hand_active) return save(T);
      await closeTable(T, "idle — no action");
    }
  }
  const due = (T) => { const t = clock(); return (T.dl.turn && T.dl.turn <= t) || (T.dl.next && T.dl.next <= t) || (T.dl.idle && T.dl.idle <= t); };

  async function recover(T) {
    const e = T.eng;
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
        console.log(`[casino] ${T.id}: cash-out ${it.key} finished after a restart`);
      }
      T.intent = null;
    }
    await bookRake(T);
    const t = clock();
    if (e.hand_active) {
      const k = H.currentActor(e);
      if (k) { T.turn = { uid: k, hand: e.hand_no, token: ++T.turn_token }; T.dl.turn = t + HC.ACT_SECS * 1000; }
    } else {
      if (T.hand) {                                      // the hand ended but its wrap-up didn't run
        await afterHand(T, { busted: e.seats.filter((k) => (e.chips[k] || 0) === 0) });
        return;
      }
      if (T.dl.next && T.dl.next < t + 1000) T.dl.next = t + HC.NEXT_SECS * 1000;
      if (T.dl.idle && T.dl.idle < t + 1000) T.dl.idle = t + HC.IDLE_SECS * 1000;
      if (!T.dl.next && !T.dl.idle) T.dl.idle = t + HC.IDLE_SECS * 1000;
    }
    await save(T);
  }

  // ── views ──
  function publicView(T) {
    const e = T.eng;
    const inHand = e.hand_active ? e.players : [];
    const actor = H.currentActor(e);
    const winners = new Set(((T.last_round || {}).winners || []).map((w) => w.name));
    const shown = new Map(((T.last_round || {}).shown || []).map((s) => [s.seat, s]));
    const seats = e.seats.map((k) => {
      let status = "waiting";
      if (inHand.includes(k)) status = e.folded.includes(k) ? "folded" : e.allin.includes(k) ? "allin" : "active";
      const sd = !e.hand_active ? shown.get(uidHash(k)) : null;
      const p = T.players[k] || {};
      return { name: e.names[k], seat: uidHash(k), via: p.via || "web", stack: e.chips[k] || 0, bet: e.hand_active ? e.street_paid[k] || 0 : 0,
               status, cards_down: inHand.includes(k) && !e.folded.includes(k), button: k === e.button,
               blind: e.hand_active && k === e.sb_key ? "SB" : e.hand_active && k === e.bb_key ? "BB" : null, turn: k === actor,
               leaving: e.leaving.includes(k), host: k === T.host.uid, shown: sd ? sd.cards : null, hand: sd ? sd.hand : null,
               winner: !e.hand_active && winners.has(e.names[k]) };
    });
    let turn = null;
    if (actor && e.seats.includes(actor)) {
      const paid = e.street_paid[actor] || 0, stack = e.chips[actor] || 0, tc = H.toCall(e, actor);
      turn = { name: e.names[actor], seat: uidHash(actor), to_call: tc, can_check: tc === 0, current_bet: e.current_bet,
               min_to: e.current_bet > 0 ? e.current_bet + e.min_raise : e.bb, max_to: paid + stack, paid, can_raise: stack > tc, deadline: T.dl.turn };
    }
    const pots = e.hand_active ? H.buildPots(e.players, e.contrib, e.folded).map((p) => ({ amount: p.amount, players: p.eligible.length })) : [];
    const room = T.room ? S.rooms.get(T.room) : null;
    return {
      id: T.id, game: "holdem", status: T.status, rev: T.rev, room: T.room, room_name: room ? room.name : T.room, rooms: roomList(T), host: T.host.name,
      phase: T.status === "closed" ? "closed" : e.hand_active ? H.STREET_NAME[e.street] : "between", hand_no: e.hand_no,
      sb: e.sb, bb: e.bb, min_buy: T.min_buy, max_buy: T.max_buy, high_stakes: T.high_stakes, max_seats: HC.MAX_SEATS, act_secs: HC.ACT_SECS,
      rake_pct: HC.RAKE * 100, board: e.board.slice(), pot: H.pot(e), pots, current_bet: e.current_bet, seats, turn,
      next_at: T.dl.next, idle_at: T.dl.idle, client_seed: T.client_seed,
      commitment: e.hand_active && T.hand ? T.hand.commitment : T.next ? T.next.commitment : null,
      commit_round: e.hand_active && T.hand ? T.hand.no : T.next ? T.next.no : null,
      last_round: e.hand_active ? null : T.last_round, last_revealed: T.last_hand_revealed || null, url: link(T),
      log: T.log.slice(-20),
    };
  }

  async function meView(T, uid, u) {
    const e = T.eng;
    const c = cardsFor(T, uid);
    const actor = H.currentActor(e);
    return {
      seat: e.seats.includes(uid) ? uidHash(uid) : null, stack: e.chips[uid] || 0, in_hand: e.hand_active && e.players.includes(uid),
      cards: c ? c.cards : null, folded: c ? c.folded : false, my_turn: actor === uid, leaving: e.leaving.includes(uid),
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
