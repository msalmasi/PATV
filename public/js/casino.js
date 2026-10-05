// casino.js — the live table on /casino, /poker and /blackjack (tables.js serves the data).
// Polls /api/tables/state about once a second, draws the felt, seats and cards, and sends the
// signed-in player's moves to /api/tables/act. Your own hole cards come only in `me.seats`, which
// the server fills for you alone.
(function () {
  "use strict";
  const root = document.getElementById("cz");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const FOCUS = root.dataset.focus;
  const SIGNED = root.dataset.signed === "1";
  const TABLE = root.dataset.table || null;     // /casino/t/<id>: this table only
  const SUIT = { s: "♠", h: "♥", d: "♦", c: "♣" };
  const SUITN = { s: "spades", h: "hearts", d: "diamonds", c: "clubs" };
  const RANKN = { A: "Ace", K: "King", Q: "Queen", J: "Jack", T: "10" };
  const OUT = { blackjack: ["BJ", "gold"], win: ["WIN", "green"], push: ["PUSH", ""], lose: ["LOSS", "red"], bust: ["BUST", "red"] };

  let S = null;            // last state
  let curT = null;         // the table drawn in the live view (actions are aimed at its id)
  let offset = 0;          // server clock - our clock (ms)
  let sending = false;
  let lastSent = null;     // id of our last request, to report its result
  let reported = new Set();
  let sigLive = "", sigCtl = "", sigLobby = "", sigLog = "", sigActs = "";
  const seen = new Set();  // cards already drawn (for the deal animation)

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString();
  const now = () => Date.now() + offset;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mySeat = (t) => (S && S.me && S.me.seats || []).find((x) => x.table === t.id) || null;
  // which table the live view shows: the page's own table, else the featured one (the main stage)
  const pick = () => (TABLE ? S.tables.find((t) => t.id === TABLE) || null : S.tables.find((t) => t.featured) || S.tables[0] || null);

  function card(c, key, extra) {
    const r = c[0] === "T" ? "10" : c[0];
    const k = key + ":" + c;
    const fresh = !seen.has(k);
    seen.add(k);
    return `<span class="cd${"hd".includes(c[1]) ? " red" : ""}${fresh ? " new" : ""}${extra ? " " + extra : ""}" role="img" aria-label="${RANKN[c[0]] || c[0]} of ${SUITN[c[1]]}">` +
      `<span class="cr" aria-hidden="true">${r}</span><span class="cs" aria-hidden="true">${SUIT[c[1]]}</span></span>`;
  }
  const back = (extra) => `<span class="cd back${extra ? " " + extra : ""}" role="img" aria-label="face-down card"></span>`;
  const clock = (dl, total) => (dl ? `<div class="tbar" data-dl="${dl}" data-total="${(total || 30) * 1000}" aria-hidden="true"><i></i></div>` +
    `<span class="sr clock" data-dl="${dl}" role="timer"></span>` : "");

  function status(text, bad) {
    const el = $("cz-status");
    el.textContent = text || "";
    el.className = "status" + (bad ? " bad" : "");
  }

  // ── seat positions round the felt (index 0 = bottom centre, then clockwise) ──
  function place(n, i, bjMode) {
    let a;
    if (bjMode) {             // blackjack: an arc along the bottom, left to right
      const span = Math.min(160, 40 + n * 22);
      a = (90 + span / 2 - (n === 1 ? span / 2 : (span * i) / (n - 1))) * Math.PI / 180;
    } else {
      a = (90 + (360 * i) / n) * Math.PI / 180;
    }
    return { x: 50 + 49 * Math.cos(a), y: 50 + 58 * Math.sin(a), top: Math.sin(a) < -0.2 };
  }

  // ── Hold'em ──
  function holdemSeat(t, s, i, me) {
    const ms = mySeat(t);
    const mine = !!ms && ms.seat === i;
    const cls = ["seat", s.status, mine ? "me" : "", s.turn ? "turn" : "", s.winner ? "winner" : ""].join(" ");
    let cards = "";
    const key = `${t.id}:${t.hand_no}:${i}`;
    if (mine && ms.cards && ms.cards.length && (t.phase !== "between" || !s.shown)) {
      cards = ms.cards.map((c) => card(c, key, s.status === "folded" ? "dim" : "")).join("");
    } else if (s.shown) {
      cards = s.shown.map((c) => card(c, key)).join("");
    } else if (s.cards_down) {
      cards = back() + back();
    }
    const tags = [];
    if (s.button) tags.push('<span class="tag d" title="Dealer button">D</span>');
    if (s.blind) tags.push(`<span class="tag">${s.blind}</span>`);
    if (s.status === "allin") tags.push('<span class="tag red">all-in</span>');
    if (s.status === "folded") tags.push('<span class="tag">folded</span>');
    if (s.status === "waiting" && t.phase !== "between") tags.push('<span class="tag">next hand</span>');
    if (s.leaving) tags.push('<span class="tag">leaving</span>');
    if (s.host) tags.push('<span class="tag" title="Table host">host</span>');
    if (s.winner) tags.push('<span class="tag gold">winner</span>');
    if (mine) tags.push('<span class="tag green">you</span>');
    const dl = s.turn && t.turn ? t.turn.deadline : null;
    return `<div class="${cls}" data-i="${i}">` +
      (s.bet ? `<span class="bet"><span class="chip"></span>${fmt(s.bet)}</span>` : "") +
      `<div class="nm">${esc(s.name)}</div><div class="st">${fmt(s.stack)}</div>` +
      (cards ? `<div class="hc">${cards}</div>` : "") +
      (s.hand ? `<div class="hn">${esc(s.hand)}</div>` : "") +
      `<div class="tags">${tags.join("")}</div>${clock(dl, t.act_secs)}</div>`;
  }

  function holdemCenter(t) {
    const slots = [];
    for (let k = 0; k < 5; k++) slots.push(t.board[k] ? card(t.board[k], `${t.id}:${t.hand_no}:b`) : '<span class="slot" aria-hidden="true"></span>');
    let msg = "";
    if (t.phase === "between") {
      if (t.result && t.result.winners.length) {
        msg = `<div class="result">🏆 ${t.result.winners.map((w) => `${esc(w.name)} +${fmt(w.amount)} <span style="color:#ccc">(${esc(w.hand)})</span>`).join(" · ")}</div>`;
      }
      if (t.next_at) msg += `<div class="msg">Next hand in <b class="cnt" data-dl="${t.next_at}">…</b></div>`;
      else if (t.can_deal) msg += '<div class="msg">Ready — anyone seated can deal.</div>';
      else msg += `<div class="msg">Waiting for players — ${fmt(t.min_buy)}–${fmt(t.max_buy)} buy-in.</div>`;
    } else if (t.turn) {
      msg = `<div class="msg">${esc(t.turn.name)} to act · <b class="cnt" data-dl="${t.turn.deadline || ""}">…</b></div>`;
    }
    const pots = t.pots.length > 1 ? `<div class="pots">${t.pots.map((p, k) => `${k ? "side " + k : "main"} ${fmt(p.amount)}`).join(" · ")}</div>` : "";
    return `<div class="ttl">Hold'em ${fmt(t.sb)}/${fmt(t.bb)}${t.high_stakes ? " · High Roller" : ""}${t.hand_no ? " · hand #" + t.hand_no : ""} · ${esc(t.phase)}</div>` +
      `<div class="board" aria-label="Board">${slots.join("")}</div>` +
      (t.pot ? `<div class="pot"><span class="chip"></span>Pot ${fmt(t.pot)}</div>` : "") + pots + msg;
  }

  // ── Blackjack ──
  function bjSeat(t, s, i, me) {
    const ms = mySeat(t);
    const mine = !!ms && ms.seat === i;
    const cls = ["seat", mine ? "me" : "", s.turn ? "turn" : ""].join(" ");
    const hands = s.hands.map((h, k) => {
      const o = h.outcome && OUT[h.outcome] ? `<span class="tag ${OUT[h.outcome][1]}">${OUT[h.outcome][0]}</span>` : "";
      return `<div class="bjh${h.current ? " cur" : ""}"><div class="cards">${h.cards.map((c) => card(c, `${t.id}:${t.round_no}:${i}:${k}`)).join("")}</div>` +
        `<div class="v">${h.value}${h.soft && h.value < 21 ? " soft" : ""}${h.is_bj ? " · BJ" : ""} · ${fmt(h.bet)}${h.doubled ? " ×2" : ""} ${o}</div></div>`;
    }).join("");
    const tags = [];
    if (s.insured) tags.push('<span class="tag">insured</span>');
    if (s.autobet) tags.push('<span class="tag">autobet</span>');
    if (s.pending) tags.push(`<span class="tag">next round ${fmt(s.pending)}</span>`);
    if (s.leaving) tags.push('<span class="tag">leaving</span>');
    if (s.host) tags.push('<span class="tag">host</span>');
    if (mine) tags.push('<span class="tag green">you</span>');
    const dl = s.turn && t.turn ? t.turn.deadline : null;
    return `<div class="${cls}" data-i="${i}">` +
      (s.bet ? `<span class="bet"><span class="chip"></span>${fmt(s.bet)}</span>` : "") +
      `<div class="nm">${esc(s.name)}</div>${hands || '<div class="st">no bet yet</div>'}<div class="tags">${tags.join("")}</div>${clock(dl, t.act_secs)}</div>`;
  }

  function bjCenter(t) {
    const d = t.dealer;
    const dc = d.cards.map((c) => card(c, `${t.id}:${t.round_no}:d`)).join("") + (d.down ? back() : "");
    let msg = "";
    if (t.phase === "betting" || t.phase === "idle") {
      msg = `<div class="msg">Place your bets · ${fmt(t.min_bet)}–${fmt(t.max_bet)}${t.bet_deadline ? ` · dealing in <b class="cnt" data-dl="${t.bet_deadline}">…</b>` : ""}</div>`;
      if (t.result) {
        msg = `<div class="result">Round ${t.result.round_no}: Pepe ${t.result.dealer.value}${t.result.dealer.bust ? " BUST" : t.result.dealer.blackjack ? " BJ" : ""} — ` +
          t.result.players.map((p) => `${esc(p.name)} ${p.net > 0 ? "+" : ""}${fmt(p.net)}`).join(" · ") + "</div>" + msg;
      }
    } else if (t.phase === "insurance") {
      msg = `<div class="msg">Pepe shows an Ace — insurance? <b class="cnt" data-dl="${t.ins_deadline || ""}">…</b></div>`;
    } else if (t.turn) {
      msg = `<div class="msg">${esc(t.turn.name)}${t.turn.num_hands > 1 ? ` (hand ${t.turn.hand_index + 1}/${t.turn.num_hands})` : ""} to act · <b class="cnt" data-dl="${t.turn.deadline || ""}">…</b></div>`;
    } else if (t.phase === "dealer") {
      msg = '<div class="msg">Pepe plays his hand…</div>';
    }
    return `<div class="ttl">Blackjack · round ${t.round_no} · ${t.decks}-deck · pays 3:2</div>` +
      `<div class="dealer"><div class="cards" aria-label="Pepe's cards">${dc || '<span class="slot"></span><span class="slot"></span>'}</div>` +
      (d.cards.length ? `<div class="msg">Pepe ${d.hidden ? "shows " : ""}${d.value}${d.bust ? " — BUST" : d.blackjack ? " — BLACKJACK" : ""}</div>` : "") + `</div>` + msg;
  }

  function renderLive() {
    const t = pick();
    curT = t;
    const el = $("cz-live");
    if (!t) {
      const sig = "none" + S.stale + S.tables.length;
      if (sig === sigLive) return;
      sigLive = sig;
      if (TABLE) {
        el.innerHTML = `<div class="card" style="text-align:center"><p style="margin:0 0 6px;color:#fff">This table has closed.</p>` +
          `<p class="info" style="margin:0"><a href="/tables">Back to the lobby</a>${S.tables.length ? " — another table is open there." : "."}</p></div>`;
        return;
      }
      el.innerHTML = `<div class="card" style="text-align:center"><p style="margin:0 0 6px;color:#fff">No table is open right now.</p>` +
        `<p class="info" style="margin:0">${S.stale ? "Pepe looks offline at the moment." : "Start one below, or type <code>!holdem start 25/50</code> / <code>!blackjack start</code> in a Camfrog room with Pepe."}</p></div>`;
      return;
    }
    const me = S.me;
    const sig = JSON.stringify([t, mySeat(t), S.stale, me && me.admin, S.rooms]);
    if (sig !== sigLive) {
      sigLive = sig;
      const bjMode = t.game === "bj";
      const n = Math.max(t.seats.length, bjMode ? 1 : 2);
      const ms = mySeat(t);
      const mySeatNo = ms ? ms.seat : -1;
      const seats = t.seats.map((s, i) => (bjMode ? bjSeat(t, s, i, me) : holdemSeat(t, s, i, me)));
      // put "you" at the bottom: rotate seat positions so your seat sits at index 0
      const rot = !bjMode && mySeatNo >= 0 ? mySeatNo : 0;
      const onFelt = seats.map((h, i) => {
        const p = place(n, (i - rot + n) % n, bjMode);
        return h.replace('<div class="seat', `<div style="left:${p.x.toFixed(1)}%;top:${p.y.toFixed(1)}%" class="${p.top ? "top " : ""}seat`);
      }).join("");
      const notice = !TABLE && FOCUS !== "lobby" && ((FOCUS === "bj") !== bjMode)
        ? `<p class="hint">A ${bjMode ? "Blackjack" : "Hold'em"} table is open, and tables run one at a time — this is it. <a href="${bjMode ? "/blackjack" : "/poker"}">Go to its page</a>.</p>` : "";
      el.innerHTML = notice +
        `<div class="felt-wrap${bjMode ? " bjw" : ""}"><div class="felt" role="group" aria-label="${bjMode ? "Blackjack" : "Hold'em"} table in ${esc(t.room_name)}">` +
        `<div class="felt-c">${bjMode ? bjCenter(t) : holdemCenter(t)}</div>${onFelt}</div></div>` +
        `<div class="seats-list" aria-hidden="true">${seats.join("")}</div>` +
        `<p class="info" style="text-align:center;margin:6px 0 0">${t.featured ? '<span class="tag gold">main stage</span> ' : ""}` +
        `${t.home.kind === "room" ? `In Camfrog room <b style="color:#fff">${esc(t.home.room_name || t.room_name)}</b>` : "Web table"} · host ${esc(t.host || "—")} · ${t.seats.length}/${t.max_seats} seats` +
        ` · <a href="/casino/t/${esc(t.id)}">table link</a>` +
        `${S.stale ? ' · <span style="color:#ff9a9a">Pepe hasn\'t updated for a while</span>' : ""}</p><div id="cz-ctl"></div>${adminCtl(t)}`;
      sigCtl = "";
    }
    renderCtl(t);
  }

  // ── controls for the signed-in, seated (or seat-taking) player ──
  function btn(label, payload, cls, extra) {
    return `<button type="button" class="b ${cls || ""}" data-act='${esc(JSON.stringify(payload))}'${sending ? " disabled" : ""}${extra || ""}>${label}</button>`;
  }

  function renderCtl(t) {
    const el = $("cz-ctl");
    if (!el) return;
    const me = S.me;
    const seat = mySeat(t);
    const sig = JSON.stringify([t.id, t.phase, t.turn, t.can_deal, seat, sending, me && me.camfrog, me && me.banned, t.game === "bj" ? t.seats.map((s) => [s.bet, s.pending, s.autobet]) : 0]);
    if (sig === sigCtl) return;
    sigCtl = sig;
    const keep = {};
    el.querySelectorAll("input").forEach((i) => { if (i.id && i.value) keep[i.id] = i.value; });
    let h = "";
    if (!SIGNED) h = `<p class="info" style="margin:0">You're watching. <a href="/login">Sign in</a> to play.</p>`;
    else if (!me || !me.camfrog) h = `<p class="info" style="margin:0">Link your Camfrog name (<code>!verify</code> in a room) to play from here.</p>`;
    else if (me.banned) h = `<p class="info" style="margin:0">You're banned from the casino.</p>`;
    else if (t.game === "holdem") h = holdemCtl(t, seat);
    else h = bjCtl(t, seat);
    el.innerHTML = `<div class="ctl">${h}</div>`;
    Object.entries(keep).forEach(([id, v]) => { const i = document.getElementById(id); if (i && i.type !== "range") i.value = v; });
    wireRaise(t);
  }

  function holdemCtl(t, seat) {
    const isHost = seat && t.seats[seat.seat] && t.seats[seat.seat].host;
    if (!seat) {
      const def = clamp(t.bb * 100, t.min_buy, t.max_buy);
      if (t.seats.length >= t.max_seats) return '<p class="info" style="margin:0">The table is full.</p>';
      return `<div class="row"><label class="lbl" for="cz-buy">Buy in (${fmt(t.min_buy)}–${fmt(t.max_buy)})</label>` +
        `<input id="cz-buy" type="number" inputmode="numeric" min="${t.min_buy}" max="${t.max_buy}" step="${t.bb}" value="${def}">` +
        `${btn("Take a seat", { game: "holdem", verb: "sit", amountFrom: "cz-buy" }, "go")}</div>`;
    }
    const mine = seat.cards && seat.cards.length ? `<div class="mycards" aria-label="Your hole cards">${seat.cards.map((c) => card(c, `${t.id}:${t.hand_no}:mine`)).join("")}<span class="lbl">your hand</span></div>` : "";
    const turn = t.turn && t.turn.seat === seat.seat ? t.turn : null;
    if (turn) {
      const call = turn.can_check ? btn("Check", { game: "holdem", verb: "check" }, "go")
        : btn(`Call ${fmt(Math.min(turn.to_call, turn.max_to - turn.paid))}`, { game: "holdem", verb: "call" }, "go");
      const verb = turn.current_bet > 0 ? "raise" : "bet";
      const lo = Math.min(turn.min_to, turn.max_to), hi = turn.max_to;
      const raise = turn.can_raise && hi > turn.current_bet
        ? `<div class="raise" role="group" aria-label="${verb === "bet" ? "Bet" : "Raise to"}">` +
          `<input id="cz-rng" type="range" min="${lo}" max="${hi}" step="${Math.max(1, Math.min(t.bb, hi - lo || 1))}" value="${lo}" aria-label="Amount">` +
          `<input id="cz-amt" type="number" inputmode="numeric" min="${lo}" max="${hi}" value="${lo}" aria-label="${verb === "bet" ? "Bet amount" : "Raise to"}">` +
          `<button type="button" class="b ghost mini" data-set="min">Min</button><button type="button" class="b ghost mini" data-set="half">½ pot</button>` +
          `<button type="button" class="b ghost mini" data-set="pot">Pot</button>` +
          btn(verb === "bet" ? "Bet" : "Raise to", { game: "holdem", verb, amountFrom: "cz-amt" }, "gold", ' id="cz-raise"') + `</div>` : "";
      return `${mine}<div class="row"><b style="color:#ffd700">Your turn</b><span class="lbl">to call ${fmt(turn.to_call)} · stack ${fmt(t.seats[seat.seat].stack)}</span></div>` +
        `<div class="row">${btn("Fold", { game: "holdem", verb: "fold" }, "stop")}${call}${btn("All-in", { game: "holdem", verb: "allin" }, "warn")}</div>${raise}`;
    }
    const rows = [];
    if (t.phase !== "between") rows.push(`<span class="lbl">${t.turn ? "Waiting for " + esc(t.turn.name) + "…" : "…"}</span>`);
    if (t.phase === "between" && t.can_deal) rows.push(btn("Deal now", { game: "holdem", verb: "deal" }, "go"));
    rows.push(btn(seat.leaving ? "Leaving after this hand" : "Stand up (cash out)", { game: "holdem", verb: "stand" }, "ghost", seat.leaving ? " disabled" : ""));
    if (isHost && t.phase === "between") rows.push(btn("Close table", { game: "holdem", verb: "end" }, "stop"));
    const top = t.phase === "between" && t.seats[seat.seat].stack < t.max_buy
      ? `<div class="row"><label class="lbl" for="cz-top">Top up</label><input id="cz-top" type="number" inputmode="numeric" min="${t.min_buy}" max="${Math.max(t.min_buy, t.max_buy - t.seats[seat.seat].stack)}" step="${t.bb}" value="${t.min_buy}">` +
        `${btn("Add chips", { game: "holdem", verb: "sit", amountFrom: "cz-top" }, "")}</div>` : "";
    return `${mine}<div class="row">${rows.join("")}</div>${top}`;
  }

  function bjCtl(t, seat) {
    const s = seat ? t.seats[seat.seat] : null;
    const isHost = s && s.host;
    const turn = t.turn && seat && t.turn.seat === seat.seat ? t.turn : null;
    if (turn) {
      return `<div class="row"><b style="color:#ffd700">Your turn${turn.num_hands > 1 ? ` — hand ${turn.hand_index + 1} of ${turn.num_hands}` : ""}</b></div><div class="row">` +
        btn("Hit", { game: "bj", verb: "hit" }, "go") + btn("Stand", { game: "bj", verb: "stand" }, "") +
        (turn.can_double ? btn("Double", { game: "bj", verb: "double" }, "gold") : "") +
        (turn.can_split ? btn("Split", { game: "bj", verb: "split" }, "warn") : "") + "</div>";
    }
    const rows = [];
    if (t.phase === "insurance" && seat && seat.insurance > 0) {
      rows.push(`<div class="row">${btn(`Take insurance (${fmt(seat.insurance)})`, { game: "bj", verb: "insurance" }, "gold")}<span class="lbl">pays 2:1 if Pepe has blackjack</span></div>`);
    }
    const betting = t.phase === "betting" || t.phase === "idle";
    const already = s && s.bet > 0;
    const def = clamp((seat && seat.lastbet) || t.min_bet * 5, t.min_bet, t.max_bet);
    if (!already && (!s || !s.pending) && (s || t.seats.length < t.max_seats)) {
      rows.push(`<div class="row"><label class="lbl" for="cz-bet">${betting ? "Bet" : "Bet for the next round"} (${fmt(t.min_bet)}–${fmt(t.max_bet)})</label>` +
        `<input id="cz-bet" type="number" inputmode="numeric" min="${t.min_bet}" max="${t.max_bet}" step="${t.min_bet}" value="${def}">` +
        `${btn(betting ? "Place bet" : "Join next round", { game: "bj", verb: "bet", amountFrom: "cz-bet" }, "go")}</div>`);
    } else if (!s && t.seats.length >= t.max_seats) {
      rows.push('<p class="info" style="margin:0">The table is full.</p>');
    }
    const r2 = [];
    if (betting && t.seats.some((x) => x.bet > 0)) r2.push(btn("Deal now", { game: "bj", verb: "deal" }, ""));
    if (seat) {
      r2.push(seat.autobet ? btn("Autobet off", { game: "bj", verb: "autobet", amount: "off" }, "ghost")
        : (seat.lastbet ? btn(`Autobet ${fmt(seat.lastbet)}`, { game: "bj", verb: "autobet", amount: String(seat.lastbet) }, "ghost") : ""));
      r2.push(btn(s && s.leaving ? "Leaving after this round" : "Leave table", { game: "bj", verb: "leave" }, "ghost", s && s.leaving ? " disabled" : ""));
    }
    if (isHost && betting) r2.push(btn("Close table", { game: "bj", verb: "end" }, "stop"));
    if (r2.length) rows.push(`<div class="row">${r2.join("")}</div>`);
    if (!betting && !t.turn && t.phase !== "insurance") rows.unshift('<span class="lbl">Round in progress…</span>');
    else if (t.turn && !turn) rows.unshift(`<span class="lbl">Waiting for ${esc(t.turn.name)}…</span>`);
    return rows.join("") || '<span class="lbl">…</span>';
  }

  function adminCtl(t) {
    if (!S.me || !S.me.admin) return "";
    const rooms = (S.rooms || []).filter((r) => r[t.game] && r.id !== t.home.room);
    return `<div class="ctl" role="group" aria-label="Admin: main stage"><div class="row"><span class="lbl">Admin</span>` +
      (t.featured ? btn("Take off the main stage", { game: "admin", verb: "unfeature" }, "ghost") : btn("Push to the main stage", { game: "admin", verb: "feature" }, "gold")) +
      (rooms.length ? `<label class="lbl" for="cz-push">Move to room</label><select id="cz-push">${rooms.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")}</select>` +
        btn("Push to room", { game: "admin", verb: "push", roomFrom: "cz-push" }, "") : "") + `</div>` +
      `<p class="info" style="margin:0">The main-stage table shows on the stream overlay and as this site's main table. Moving a table works between hands.</p></div>`;
  }

  function wireRaise(t) {
    const rng = $("cz-rng"), amt = $("cz-amt");
    if (!rng || !amt) return;
    const lo = Number(rng.min), hi = Number(rng.max);
    rng.addEventListener("input", () => { amt.value = rng.value; label(); });
    amt.addEventListener("input", () => { rng.value = clamp(Number(amt.value) || lo, lo, hi); label(); });
    root.querySelectorAll("[data-set]").forEach((b) => b.addEventListener("click", () => {
      const tu = t.turn;
      const potAfterCall = t.pot + (tu ? tu.to_call : 0);
      const v = b.dataset.set === "min" ? lo : b.dataset.set === "half" ? tu.current_bet + Math.round(potAfterCall / 2) : tu.current_bet + potAfterCall;
      amt.value = clamp(v, lo, hi);
      rng.value = amt.value;
      label();
    }));
    function label() {
      const b = $("cz-raise");
      const v = clamp(Number(amt.value) || lo, lo, hi);
      if (b) b.textContent = (v >= hi ? "All-in " : (t.turn.current_bet > 0 ? "Raise to " : "Bet ")) + fmt(v);
    }
    label();
  }

  // ── lobby: open tables + start form ──
  function renderLobby() {
    const me = S.me;
    const canPlay = SIGNED && me && me.camfrog && !me.banned;
    const sig = JSON.stringify([S.tables.map((t) => [t.id, t.game, t.room_name, t.seats.length, t.phase, t.featured]), S.rooms, S.busy, S.stale, canPlay, sending, S.max_tables]);
    if (sig === sigLobby) return;
    sigLobby = sig;
    const keep = {};
    $("cz-lobby").querySelectorAll("input,select").forEach((i) => { if (i.id) keep[i.id] = i.value; });
    let h = '<div class="card tlist">';
    if (S.tables.length) {
      h += S.tables.map((t) => `<div class="trow"><span><b>${t.game === "bj" ? "🂡 Blackjack" : "🃏 Hold'em " + fmt(t.sb) + "/" + fmt(t.bb)}</b> ${t.featured ? '<span class="tag gold">main stage</span> ' : ""}<span class="info">in ${esc(t.home.room_name || t.room_name)}</span></span>` +
        `<span class="info">${t.seats.length} player${t.seats.length === 1 ? "" : "s"} · ${t.game === "bj" ? fmt(t.min_bet) + "–" + fmt(t.max_bet) + " bets" : fmt(t.min_buy) + "–" + fmt(t.max_buy) + " buy-in"}</span>` +
        `<a href="/casino/t/${esc(t.id)}">Watch / play →</a></div>`).join("");
    } else {
      h += '<p class="info" style="margin:0">No tables open.</p>';
    }
    h += "</div>";
    // start form
    const rooms = S.rooms || [];
    const blocked = S.tables.length >= (S.max_tables || 1) ? `A table is already open — ${S.max_tables || 1} at a time for now.` : S.busy ? `${S.busy.charAt(0).toUpperCase() + S.busy.slice(1)} is running — tables open when it's over.` : S.stale ? "Pepe is offline right now." : !rooms.length ? "Pepe isn't in any rooms right now." : "";
    h += '<div class="card" style="margin-top:12px"><h3 style="margin-top:0">Start a table</h3>';
    if (!canPlay) {
      h += `<p class="info" style="margin:0">${!SIGNED ? '<a href="/login">Sign in</a> and link your Camfrog name to open a table from here.' : me && me.banned ? "You're banned from the casino." : "Link your Camfrog name (<code>!verify</code>) to open a table from here."}</p>`;
    } else if (blocked) {
      h += `<p class="info" style="margin:0">${esc(blocked)}</p>`;
    } else {
      const g0 = FOCUS === "bj" ? "bj" : "holdem";
      h += `<form class="start" id="cz-start"><div class="row"><label class="lbl" for="cz-sg">Game</label><select id="cz-sg">` +
        `<option value="holdem"${g0 === "holdem" ? " selected" : ""}>Texas Hold'em</option><option value="bj"${g0 === "bj" ? " selected" : ""}>Blackjack</option></select></div>` +
        `<div class="row"><label class="lbl" for="cz-sr">Camfrog room</label><select id="cz-sr"></select></div>` +
        `<div class="row" id="cz-blinds-row"><label class="lbl" for="cz-sb">Blinds</label><input id="cz-sb" type="text" inputmode="numeric" value="25/50" pattern="\\d+/\\d+" style="width:120px" aria-describedby="cz-sb-h">` +
        `<span class="info" id="cz-sb-h">small/big, up to ${fmt((S.config && S.config.holdem.sb_cap) || 5000)}/${fmt((S.config && S.config.holdem.bb_cap) || 10000)}</span></div>` +
        `<div class="row"><button type="submit" class="b go"${sending ? " disabled" : ""}>Open the table</button></div>` +
        `<p class="info" style="margin:0">It opens in that Camfrog room, and you're the host. Then take a seat.</p></form>`;
    }
    h += "</div>";
    $("cz-lobby").innerHTML = h;
    const f = $("cz-start");
    if (!f) return;
    const sg = $("cz-sg"), sr = $("cz-sr");
    Object.entries(keep).forEach(([id, v]) => { const i = document.getElementById(id); if (i && i.tagName !== "SELECT") i.value = v; });
    if (keep["cz-sg"]) sg.value = keep["cz-sg"];
    const fill = () => {
      const g = sg.value;
      const ok = rooms.filter((r) => r[g]);
      sr.innerHTML = ok.length ? ok.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("") : '<option value="">(switched off in every room)</option>';
      if (keep["cz-sr"] && ok.some((r) => r.id === keep["cz-sr"])) sr.value = keep["cz-sr"];
      $("cz-blinds-row").hidden = g !== "holdem";
    };
    sg.addEventListener("change", fill);
    fill();
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const g = sg.value;
      if (!sr.value) return status("Pick a room.", true);
      send(g === "holdem" ? { game: g, verb: "start", room: sr.value, blinds: $("cz-sb").value } : { game: g, verb: "start", room: sr.value });
    });
  }

  function renderLog() {
    const t = curT;
    const game = t ? t.game : FOCUS === "bj" ? "bj" : FOCUS === "holdem" ? "holdem" : null;
    const lines = S.log.filter((l) => !game || l.game === game).slice(-20).reverse();
    const sig = JSON.stringify(lines);
    if (sig === sigLog) return;
    sigLog = sig;
    $("cz-log").innerHTML = lines.length ? lines.map((l) => `<div><time>${new Date(l.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>${esc(l.text)}</div>`).join("")
      : '<span class="info">Nothing yet.</span>';
  }

  function renderActs() {
    const acts = (S.me && S.me.actions) || [];
    $("cz-acts-wrap").hidden = !acts.length;
    for (const a of acts) {               // report the result of what we just sent
      if (a.id === lastSent && (a.status === "done" || a.status === "failed") && !reported.has(a.id)) {
        reported.add(a.id);
        status(a.status === "done" ? (a.message && a.message !== "done" ? a.message : "Done.") : (a.message || "That didn't work."), a.status === "failed");
      }
    }
    const sig = JSON.stringify(acts);
    if (sig === sigActs) return;
    sigActs = sig;
    $("cz-acts").innerHTML = acts.map((a) => `<div class="${esc(a.status)}"><span>${a.status === "done" ? "✅" : a.status === "failed" ? "❌" : "⏳"}</span>` +
      `<span class="lab">${esc(a.label)}</span><span class="m">${a.status === "pending" || a.status === "claimed" ? "waiting for Pepe…" : esc(a.message || "")}</span></div>`).join("");
  }

  // ── clocks ──
  function tick() {
    const n = now();
    root.querySelectorAll(".tbar[data-dl]").forEach((b) => {
      const left = Number(b.dataset.dl) - n, total = Number(b.dataset.total) || 30000;
      b.firstChild.style.width = clamp((left / total) * 100, 0, 100) + "%";
      b.classList.toggle("low", left < 10000);
    });
    root.querySelectorAll(".cnt[data-dl], .clock[data-dl]").forEach((c) => {
      const dl = Number(c.dataset.dl);
      if (!dl) { c.textContent = ""; return; }
      const s = Math.max(0, Math.ceil((dl - n) / 1000));
      c.textContent = s + "s";
    });
  }

  // ── sending ──
  async function send(payload) {
    if (sending) return;
    const p = Object.assign({}, payload);
    if (p.verb !== "start" && !p.table && curT) p.table = curT.id;     // aim at the table on screen
    if (p.roomFrom) {
      const r = $(p.roomFrom);
      p.room = r ? r.value : "";
      delete p.roomFrom;
    }
    if (p.amountFrom) {
      const i = $(p.amountFrom);
      p.amount = i ? String(i.value).trim() : "";
      delete p.amountFrom;
      if (!/^\d+$/.test(p.amount)) return status("Enter a whole number.", true);
    }
    sending = true;
    status("Sending to Pepe…");
    sigCtl = sigLobby = "";
    if (S) { renderLive(); renderLobby(); }
    try {
      const r = await fetch("/api/tables/act", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, body: JSON.stringify(p) });
      const j = await r.json().catch(() => ({}));
      if (j.ok) { lastSent = j.id; status("Sent — Pepe's on it…"); }
      else status(j.error || "That didn't go through.", true);
    } catch (e) {
      status("Couldn't reach the site — check your connection.", true);
    }
    sending = false;
    sigCtl = sigLobby = "";
    poll(true);
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b || b.disabled) return;
    try { send(JSON.parse(b.dataset.act)); } catch (err) { /* ignore */ }
  });

  // ── polling ──
  let timer = null, inflight = false;
  async function poll(soon) {
    clearTimeout(timer);
    if (!inflight) {
      inflight = true;
      try {
        const r = await fetch("/api/tables/state", { credentials: "same-origin", cache: "no-store" });
        if (r.ok) {
          const j = await r.json();
          offset = j.now - Date.now();
          S = j;
          renderLive();
          renderLobby();
          renderLog();
          renderActs();
          tick();
        }
      } catch (e) { /* try again next tick */ }
      inflight = false;
    }
    timer = setTimeout(poll, soon ? 400 : document.hidden ? 5000 : 1000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  setInterval(tick, 250);
  poll();
})();
