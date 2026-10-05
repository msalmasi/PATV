// history.js — a readable PAT transaction history (Pepe 1.68).
//
// The transactions table stores terse machine types ("Wager: Gold Spin", "bonus win", "heist-gear",
// "tip sent"...). This turns each row into a sentence a person understands ("Spun the gold wheel",
// "Sent 50,000 PAT to bob", "Cracked a vault on a heist"), with an icon and a category, and joins in
// what it needs: the real reason behind a "bonus win" (bonus_winners.type) and the other person on
// a tip (the new transactions.counterparty column; older tips are paired by time + amount).
const { runQuery, getQuery } = require("./dbUtils");

const ready = runQuery("ALTER TABLE transactions ADD COLUMN counterparty TEXT").catch(() => {});

const CATS = {
  wheel: "🎡 Wheel", casino: "🎰 Casino", heist: "🥷 Heists & turf", games: "🥊 Games & fights",
  tips: "💸 Tips", shop: "🛍️ Shop & prizes", pepe: "🐸 Pepe commands", rewards: "🏅 Rewards & bonuses",
  admin: "🛠️ Admin & other",
};

const nice = (s) => String(s || "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// [regex on the type, category, icon, text(amount, match, row)]
const RULES = [
  [/^Wager: (Gold|Public) Spin$/i, "wheel", "🎡", (a, m) => `Spun the ${m[1].toLowerCase()} wheel`],
  [/^Reward: (Gold|Public) Spin$/i, "wheel", "🎡", (a, m) => a > 0 ? `Won ${a.toLocaleString()} PAT on the ${m[1].toLowerCase()} wheel` : `Spun the ${m[1].toLowerCase()} wheel — no prize`],
  [/^Jackpot Win$/i, "wheel", "💥", (a) => `Hit the wheel JACKPOT`],
  [/^Jackpot Win \(partial\)$/i, "wheel", "💥", () => `Won a share of the wheel jackpot`],
  [/^Jackpot Near Miss$/i, "wheel", "😬", () => `Wheel jackpot near miss`],
  [/^purchase of \+?100 Daily Gold Spins$/i, "shop", "🎡", () => `Bought +100 daily gold spins`],
  [/^wheel prize shortfall$/i, "wheel", "🎡", () => `Wheel prize top-up`],
  [/^tip sent$/i, "tips", "💸", (a, m, r) => r.cp ? `Tipped` : `Tipped someone`, ""],
  [/^tip received$/i, "tips", "💰", (a, m, r) => r.cp ? `Tip from` : `Tip from someone`, ""],
  [/^jackpot-donation$/i, "casino", "🎰", () => `Donated to the casino jackpot`],
  [/^(blackjack wager|blackjack-bet|blackjack-autobet)$/i, "casino", "🂡", () => `Blackjack bet`],
  [/^blackjack-(double|split|insurance)$/i, "casino", "🂡", (a, m) => `Blackjack ${m[1]}`],
  [/^(blackjack payout|blackjack-payout)$/i, "casino", "🂡", () => `Blackjack winnings`],
  [/^blackjack-restart-refund$/i, "casino", "↩️", () => `Blackjack bet refunded (restart)`],
  [/^holdem-buyin$/i, "casino", "♠️", () => `Bought into hold'em`],
  [/^holdem-(cashout|restart-refund)$/i, "casino", "♠️", () => `Cashed out of hold'em`],
  [/^lotto-tickets$/i, "casino", "🎟️", () => `Bought lotto tickets`],
  [/^lotto-jackpot$/i, "casino", "🎰", () => `Won the LOTTO JACKPOT`],
  [/^lotto-(\d)(pb)?$/i, "casino", "🎟️", (a, m) => `Lotto prize (${m[1]}${m[2] ? " + Pepe Ball" : ""})`],
  [/^lotto-.*refund$/i, "casino", "↩️", () => `Lotto tickets refunded`],
  [/^bingo-cards$/i, "casino", "🔢", () => `Bought bingo cards`],
  [/^bingo-(line|blackout|rollover)$/i, "casino", "🔢", (a, m) => `Won bingo (${m[1]})`],
  [/^bingo-false-call$/i, "casino", "🔢", () => `Bingo false-call penalty`],
  [/^wager-stake$/i, "casino", "🤝", () => `Put up a wager`, "vs"],
  [/^wager-win$/i, "casino", "🤝", () => `Won a wager`, "vs"],
  [/^loan-principal$/i, "casino", "💳", () => `Lent PAT`, "to"],
  [/^bounty-post$/i, "games", "🎯", () => `Posted a bounty`],
  [/^bounty-add$/i, "games", "🎯", () => `Chipped in to a bounty`],
  [/^bounty-win$/i, "games", "🎯", () => `Collected a bounty`, "from"],
  [/^stash-deposit$/i, "admin", "🔐", () => `Moved PAT into a personal vault`],
  [/^stash-withdraw$/i, "admin", "🔐", () => `Took PAT out of a personal vault`],
  [/^stash-deposit-refund$/i, "admin", "↩️", () => `Vault deposit refunded`],
  [/^loan-received$/i, "casino", "💳", () => `Borrowed PAT`, "from"],
  [/^loan-repayment$/i, "casino", "💳", (a, m, r) => r.points < 0 ? `Repaid a loan` : `Loan repayment`, (r) => r.points < 0 ? "to" : "from"],
  [/^market-stake$/i, "casino", "🔮", () => `Bet on a prediction market`],
  [/^market-win$/i, "casino", "🔮", () => `Won a prediction market bet`],
  [/^loan-/i, "casino", "💳", (a, m, r) => cap(nice(r.type))],
  [/^heist-buyin$/i, "heist", "🥷", () => `Joined a heist`],
  [/^heist-gear$/i, "heist", "🧰", () => `Bought heist gear`],
  [/^heist-vault$/i, "heist", "🔓", () => `Heist loot / cracked a vault`],
  [/^heist-bail$/i, "heist", "🏃", () => `Bailed out of a heist with the loot`],
  [/^heist-lawyer$/i, "heist", "⚖️", () => `Lawyer saved some heist loot`],
  [/^heist-escape$/i, "heist", "🚪", () => `Escaped a heist with the loot`],
  [/^heist-convoy$/i, "heist", "🚚", () => `Took a convoy`],
  [/^store-score$/i, "heist", "🏪", () => `Store heist score`],
  [/^(sheet-regen)$/i, "heist", "🎲", () => `Re-rolled heist character sheet`],
  [/^avatar-regen$/i, "heist", "🖼️", () => `Re-rolled avatar`],
  [/^turf-claim(-refund)?$/i, "heist", "🗺️", (a, m) => m[1] ? `Turf claim buy-in refunded` : `Turf claim buy-in`],
  [/^turf-invade(-refund|-loot)?$/i, "heist", "⚔️", (a, m) => m[1] === "-loot" ? `Turf war loot` : m[1] ? `Raid buy-in refunded` : `Joined a turf raid`],
  [/^turf-bounty$/i, "heist", "🎯", () => `Most-wanted bounty`],
  [/^gang-(create|deposit|withdraw|disband)$/i, "heist", "🎩", (a, m) => ({ create: "Founded a gang", deposit: "Deposited to gang treasury", withdraw: "Withdrew from gang treasury", disband: "Gang disbanded — treasury share" })[m[1].toLowerCase()]],
  [/^Duel wager$/i, "games", "⚔️", () => `Duel stake`, "vs"],
  [/^Duel winnings$/i, "games", "⚔️", () => `Won a duel`, "vs"],
  [/^Duel refund$/i, "games", "↩️", () => `Duel stake refunded`],
  [/^brawl-stake$/i, "games", "🥊", () => `Brawl stake`, "vs"],
  [/^brawl-win$/i, "games", "🥊", () => `Won a brawl`, "vs"],
  [/^arena-buyin$/i, "games", "🏟️", () => `Arena buy-in`],
  [/^arena-win$/i, "games", "🏟️", () => `Won the arena`],
  [/^showdown-(buyin|win|bullseye|refund)$/i, "games", "🎯", (a, m) => ({ buyin: "Showdown buy-in", win: "Won a showdown", bullseye: "Showdown bullseye bonus", refund: "Showdown refunded" })[m[1].toLowerCase()]],
  [/^trivia-(buyin|payout|refund)$/i, "games", "🧠", (a, m) => ({ buyin: "Trivia buy-in", payout: "Won trivia", refund: "Trivia refunded" })[m[1].toLowerCase()]],
  [/^pictionary-win$/i, "games", "🖼️", () => `Won a Pictionary round`],
  [/^voice-unlock-(.+)$/i, "pepe", "🗣️", (a, m) => `Unlocked Pepe's ${m[1]} voice`],
  [/^voice-royalty/i, "pepe", "🗣️", () => `Voice royalty`],
  [/^voice-(.+)$/i, "pepe", "🗣️", (a, m) => `Used Pepe's ${m[1]} voice`],
  [/^sponsor$/i, "pepe", "📺", () => `Sponsored the room`],
  [/^(music-queue|queue)$/i, "pepe", "🎵", () => `Queued a song`],
  [/^autoclip(-refund)?$/i, "pepe", "📹", (a, m) => m[1] ? `Autoclip refunded` : `Prepaid autoclips`],
  [/^(ask|roast|look|imagine|chart|video|clip|snap|topic|remind|relay|say|music|web|epstein|camsurcharge|micsurcharge)(-refund)?$/i,
   "pepe", "🐸", (a, m) => `!${m[1].toLowerCase()}${m[2] ? " refunded" : ""}`],
  [/^command-camroast$/i, "pepe", "🔥", () => `!camroast`],
  [/^command-(\w+)$/i, "pepe", "🐸", (a, m) => ({ camsurcharge: "-cam surcharge", micsurcharge: "-mic surcharge" })[m[1].toLowerCase()] || `!${m[1].toLowerCase()}`],
  [/^music-queue-refund$/i, "pepe", "↩️", () => `Song queue refunded`],
  [/^camfrog-trivia$/i, "games", "🧠", () => `Trivia`],
  [/^heist-(round|win)$/i, "heist", "🥷", () => `Heist loot`],
  [/^heist-refund$/i, "heist", "↩️", () => `Heist buy-in refunded`],
  [/^turf-wages$/i, "heist", "🎩", () => `Gang wages`],
  [/^(brawl|arena)-refund$/i, "games", "↩️", (a, m) => `${cap(m[1])} stake refunded`],
  [/^Poker Buy-in$/i, "casino", "♠️", () => `Bought into poker`],
  [/^[\w-]+-(cancel|expired|declined|void|late|deadline|recovery|settle)-refund$/i, "casino", "↩️", (a, m, r) => cap(nice(r.type))],
  [/^store sale: (.+?) to (\S+)/i, "shop", "🛍️", (a, m) => `Sold ${m[1]} to ${m[2]}`],
  [/^shop purchase: (.+?) \(order #\d+\)$/i, "shop", "🛍️", (a, m) => `Ordered ${m[1]} in the shop`],
  [/^shop sale: (.+?) to (\S+)/i, "shop", "🛍️", (a, m) => `Sold ${m[1]} to ${m[2]} in the shop`],
  [/^shop refund: (.+?) \(order #\d+, clawback\)$/i, "shop", "↩️", (a, m) => `Shop sale reversed: ${m[1]}`],
  [/^shop refund: (.+?) \(order #\d+\)$/i, "shop", "↩️", (a, m) => `Shop refund: ${m[1]}`],
  [/^(camfrog-merge|account merge)$/i, "admin", "🔀", () => `Account merge`],
  [/^Exploit (clawback|bounty.*)$/i, "admin", "🛠️", (a, m) => `Exploit ${m[1]}`],
  [/^purchase of (.+)$/i, "shop", "🛍️", (a, m) => `Bought ${m[1]} from the prize store`],
  [/^Level-up reward/i, "rewards", "⬆️", (a, m, r) => r.type],
  [/^Achievement: (.+)$/i, "rewards", "🏅", (a, m) => `Achievement unlocked: ${m[1]}`],
  [/^Welcome PAT$/i, "rewards", "👋", () => `Welcome PAT`],
  [/^redemption \((.+)\)$/i, "rewards", "🎁", (a, m) => `Redeemed code ${m[1]}`],
  [/^(twitch|discord) connect$/i, "rewards", "🔗", (a, m) => `${cap(m[1])} connect bonus`],
  [/^camfrog-raffle$/i, "rewards", "🎟️", () => `Won the chat raffle`],
  [/^(discord|twitch)-(raffle|casino|levelup|channelpoints)$/i, "rewards", "🎁", (a, m) => `${cap(m[1])} ${nice(m[2])}`],
  [/^beg$/i, "rewards", "🥺", () => `Begged Pepe`],
  [/^mic-hourly$/i, "rewards", "🎙️", () => `Top mic of the hour`],
  [/^moan-bonus$/i, "rewards", "😏", () => `Moan bonus`],
  [/^level-up-bonus$/i, "rewards", "⬆️", () => `Level-up bonus`],
  [/^reserve-grant$/i, "admin", "🏛️", () => `Paid from the Federal Reserve`],
  [/^staff transfer$/i, "admin", "🛠️", () => `Staff transfer`],
  [/^(fine|modfine|automod-fine)(-refund)?$/i, "admin", "⚖️", (a, m) => m[2] ? `Fine refunded` : `Fined`],
  [/^Refund$/i, "admin", "↩️", () => `Refund`],
  [/^ledger-correction$/i, "admin", "📒", () => `Balance carried over from before the full history (merges, resets, older records)`],
  [/^balance-zeroed$/i, "admin", "🔀", () => `Balance moved out (account merge)`],
];

// A rule's optional 5th field is the word that joins the counterparty on ("vs", "to", "from";
// "" for tips) — or a function of the row. The page renders the name itself, with a tooltip.
function describe(row) {
  const t = String(row.type || "");
  for (const [re, cat, icon, fn, prep] of RULES) {
    const m = t.match(re);
    if (m) {
      const p = typeof prep === "function" ? prep(row) : prep;
      return { cat, icon, text: fn(Math.abs(row.points || 0), m, row), cpPrep: p === undefined ? null : p };
    }
  }
  return { cat: "admin", icon: "•", text: cap(nice(t)) || "Transaction", cpPrep: null };
}

// How a user is known elsewhere — shown in parentheses / on hover next to their name.
function identity(u) {
  if (!u) return null;
  const bits = [];
  if (u.camfrogUsername) bits.push(["Camfrog", u.camfrogUsername]);
  if (u.discordUsername) bits.push(["Discord", u.discordUsername]);
  if (u.twitchDisplayname) bits.push(["Twitch", u.twitchDisplayname]);
  const name = u.username;
  const alt = bits.map((b) => b[1]).filter((v) => v && v.toLowerCase() !== String(name).toLowerCase());
  return {
    name,
    alt: alt.length ? alt[0] : null,                              // the most useful other name, in ( )
    title: bits.length ? bits.map((b) => `${b[0]}: ${b[1]}`).join(" · ") : "PAT account only",
  };
}

// ── Counterparties for rows written before Pepe recorded them (1.72) ──
// Duel / brawl stakes are charged to both fighters in the same second for the same amount, and a
// loan repayment debits the borrower and credits the lender in the same second; a win comes a
// few seconds after its own stake; a loan's "received" follows the lender's "principal" of the
// same amount. Paired heuristically from the other users' rows around the same time.
const PAIR_SAME = { "Duel wager": 0, "brawl-stake": 0, "loan-repayment": 0.25 };   // type -> amount tolerance
const WIN_OF = { "Duel winnings": "Duel wager", "brawl-win": "brawl-stake" };
const ms = (ts) => Date.parse(String(ts).replace(" ", "T") + "Z");

async function backfillCounterparties(userId, rows) {
  const need = rows.filter((r) => !r.counterparty &&
    (PAIR_SAME[r.type] !== undefined || WIN_OF[r.type] || /^loan-(principal|received)$/.test(r.type)));
  if (!need.length) return;
  const times = need.map((r) => ms(r.timestamp)).filter((x) => !isNaN(x));
  const lo = new Date(Math.min(...times) - 86400000).toISOString().slice(0, 19).replace("T", " ");
  const hi = new Date(Math.max(...times) + 86400000).toISOString().slice(0, 19).replace("T", " ");
  const others = await getQuery(
    `SELECT t.userId, t.points, t.timestamp, COALESCE(b.type, t.type) AS type
       FROM transactions t LEFT JOIN bonus_winners b ON b.transactionId = t.transactionId
      WHERE t.userId != ? AND t.timestamp BETWEEN ? AND ?
        AND (t.type IN ('Duel wager','loan-repayment','loan-principal','loan-received')
             OR (t.type = 'bonus win' AND b.type = 'brawl-stake') OR t.type = 'brawl-stake')`,
    [userId, lo, hi]);
  for (const o of others) { o.t = ms(o.timestamp); o.points = Number(o.points) || 0; }
  const pairOf = (r) => {                      // the other side of a same-second pair
    const t = ms(r.timestamp), tol = PAIR_SAME[r.type], amt = Math.abs(Number(r.points) || 0);
    let best = null;
    for (const o of others) {
      if (o.type !== r.type || Math.abs(o.t - t) > 2000) continue;
      if (Math.abs(Math.abs(o.points) - amt) > amt * tol) continue;
      if (r.type === "loan-repayment" && Math.sign(o.points) === Math.sign(r.points)) continue;
      const d = Math.abs(o.t - t) + Math.abs(Math.abs(o.points) - amt);
      if (!best || d < best.d) best = { d, userId: o.userId };
    }
    return best && best.userId;
  };
  const mine = rows.map((r) => ({ r, t: ms(r.timestamp) }));
  for (const r of need) {
    if (PAIR_SAME[r.type] !== undefined) {
      r.counterparty = pairOf(r);
    } else if (WIN_OF[r.type]) {
      // my own stake just before the win -> whoever was on the other side of it
      const t = ms(r.timestamp);
      const stake = mine.filter((x) => x.r.type === WIN_OF[r.type] && x.t <= t && t - x.t < 180000)
        .sort((a, b) => b.t - a.t)[0];
      if (stake) r.counterparty = stake.r.counterparty || pairOf(stake.r);
    } else {
      const t = ms(r.timestamp), amt = Math.abs(Number(r.points) || 0);
      const lend = r.type === "loan-principal";
      const want = lend ? "loan-received" : "loan-principal";
      const cand = others.filter((o) => o.type === want && Math.abs(o.points) === amt &&
        (lend ? o.t >= t : o.t <= t) && Math.abs(o.t - t) < 86400000)
        .sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
      if (cand) r.counterparty = cand.userId;
    }
  }
}

const PERIODS = { "7d": "-7 days", "30d": "-30 days", "90d": "-90 days", all: null };

async function forUser(userId, { period = "30d", cat = null, page = 1, perPage = 100 } = {}) {
  await ready;
  const since = PERIODS[period] !== undefined ? PERIODS[period] : PERIODS["30d"];
  const where = since ? "AND t.timestamp >= datetime('now', ?)" : "";
  const params = since ? [userId, since] : [userId];
  const rows = await getQuery(
    `SELECT t.transactionId, t.type AS rawType, t.points, t.timestamp, t.counterparty,
            COALESCE(b.type, t.type) AS type
       FROM transactions t
       LEFT JOIN bonus_winners b ON b.transactionId = t.transactionId
      WHERE t.userId = ? ${where}
      ORDER BY t.timestamp DESC, t.rowid DESC`, params);
  try { await backfillCounterparties(userId, rows); } catch (e) { console.error("history cp backfill:", e.message); }
  // Older tips have no counterparty: pair "tip sent" with the "tip received" of the same amount
  // written at the same moment (the tip endpoint writes both rows together).
  const tipRows = rows.filter((r) => /^tip (sent|received)$/i.test(r.rawType) && !r.counterparty);
  if (tipRows.length) {
    const opp = await getQuery(
      `SELECT t.type, t.points, t.timestamp, t.userId FROM transactions t
        WHERE t.type IN ('tip sent','tip received') AND t.userId != ? AND t.timestamp IN (${tipRows.map(() => "?").join(",")})`,
      [userId, ...tipRows.map((r) => r.timestamp)]);
    for (const r of tipRows) {
      const want = /sent/i.test(r.rawType) ? "tip received" : "tip sent";
      const hit = opp.find((o) => o.type === want && o.timestamp === r.timestamp && Math.abs(o.points) === Math.abs(r.points));
      if (hit) r.counterparty = hit.userId;
    }
  }
  // Everyone named on the page, with how they're known on Camfrog / Discord / Twitch
  const ids = [...new Set(rows.map((r) => r.counterparty).filter(Boolean))];
  const people = {};
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const us = await getQuery(
      `SELECT userId, username, camfrogUsername, discordUsername, twitchDisplayname FROM users
        WHERE userId IN (${chunk.map(() => "?").join(",")})`, chunk);
    for (const u of us) people[u.userId] = identity(u);
  }
  for (const r of rows) r.points = Number(r.points) || 0;       // some legacy rows store points as text
  const items = rows.map((r) => {
    const cp = r.counterparty ? people[r.counterparty] || null : null;
    return { ...r, cp, ...describe({ type: r.type, points: r.points, cp: cp && cp.name }) };
  });
  const totals = {};
  for (const it of items) {
    const c = (totals[it.cat] = totals[it.cat] || { label: CATS[it.cat] || it.cat, in: 0, out: 0, n: 0 });
    if (it.points > 0) c.in += it.points; else c.out += -it.points;
    c.n++;
  }
  const filtered = cat ? items.filter((i) => i.cat === cat) : items;
  const pages = Math.max(1, Math.ceil(filtered.length / perPage));
  page = Math.max(1, Math.min(page, pages));
  return { totals, items: filtered.slice((page - 1) * perPage, page * perPage), page, pages, count: filtered.length };
}

module.exports = { forUser, describe, identity, CATS, PERIODS };
