// casinobj.js — the web blackjack table (/casino/blackjack/t/<id>; the lobby is casino-ui.js). D10 design pass, 2026-10-11.
// Draws the felt from /api/casino/t/<id> (polled about once a second by casino-ui.js): Pepe's cards, six seats on the arc,
// chip-button betting, hit / stand / double / split / insurance with a countdown ring on the server's deadline, deal and flip
// animations (only what changed is animated: a diff of the cards on the felt), the dealer's reveal and payout pops when a
// round settles, spectators, and the history sheet. Every move posts with an idempotency key (casino-ui.js actor()).
(function () {
  "use strict";
  const CZ = window.CZ;
  if (!CZ) return;
  const { $, T, esc, fmt } = CZ;
  if (!CZ.tableId) { CZ.startLobby(); return; }

  const SEATS = 6;
  const ref = {};
  const act = CZ.actor(ref);
  let last = null, stake = 0, drawnRound = null, popRound = null, first = true, revealAt = 0, revealTm = null, prevTurn = false, focusBet = location.hash === "#bet";

  const OUT = (o) => ({ blackjack: T("o_bj", "Blackjack"), win: T("o_win", "Win"), lose: T("o_lose", "Lose"), push: T("o_push", "Push"),
                        bust: T("o_bust", "Bust") }[o] || o);
  const isBetting = (t) => t.phase === "betting" || t.phase === "idle";

  function slots() {
    const box = $("cz-seats");
    if (box.children.length !== SEATS) {
      box.innerHTML = Array.from({ length: SEATS }, (_, i) => `<div class="seat" data-slot="${i}"><div class="hands"></div><div class="betspot"></div><div class="who"></div></div>`).join("");
    }
    return Array.from(box.children);
  }

  /** the hands one seat shows: live ones during a round, the settled ones (with outcomes) between rounds */
  function drawHands(seatEl, hands, opts) {
    const box = seatEl.querySelector(".hands");
    while (box.children.length > hands.length) box.lastChild.remove();
    while (box.children.length < hands.length) {
      const h = document.createElement("div");
      h.className = "hand";
      h.innerHTML = '<span class="cards fan"></span><span class="meta"></span>';
      box.appendChild(h);
    }
    hands.forEach((h, i) => {
      const el = box.children[i];
      el.classList.toggle("cur", !!h.current);
      CZ.drawCards(el.querySelector(".cards"), h.cards, { delay0: opts.delay0, step: opts.step, fy: "-160px" });
      const showOutcome = h.outcome && (h.outcome === "bust" || Date.now() >= revealAt);
      const v = h.value ? `<span class="val${h.value > 21 ? " bust" : h.is_bj ? " bj" : ""}">${h.is_bj ? "BJ" : esc(String(h.value))}${h.soft && h.value < 21 ? "s" : ""}</span>` : "";
      const meta = v + (h.doubled ? '<span class="tag">×2</span>' : "") + (showOutcome ? `<span class="oc ${esc(h.outcome)}">${esc(OUT(h.outcome))}</span>` : "");
      const m = el.querySelector(".meta");
      if (m.dataset.v !== meta) { m.dataset.v = meta; m.innerHTML = meta; }
      el.setAttribute("aria-label", T("hand_lbl", "Hand: {value}", { value: h.value || "" }) + (showOutcome ? " · " + OUT(h.outcome) : ""));
    });
  }

  function resetFelt() {
    for (const c of document.querySelectorAll("#cz-seats .hands")) c.textContent = "";
    const d = $("cz-dealer");
    d.textContent = "";
    delete d.dataset.sig;
  }

  function render(d) {
    const t = d.table, me = d.me;
    last = d;
    const open = t.status === "open";
    const betting = isBetting(t);
    const lr = t.last_round;
    const resultMode = betting && !!lr && t.seats.every((s) => !s.hands.length);
    const round = resultMode ? lr.round_no : t.round_no;
    const seatsN = Math.max(1, t.seats.length);
    // a different round on the felt: clear it and deal everything in (staggered like a real deal)
    let delay0 = 0, step = 0.14, dealing = false;
    if (round !== drawnRound) {
      resetFelt();
      dealing = !first && !resultMode;
      drawnRound = round;
    }
    // the dealer: hole card down while players act; between rounds the last round's hand (the reveal animates)
    const dl = t.dealer || {};
    let dcards = [], dval = "", dcls = "";
    if (resultMode) {
      dcards = lr.dealer.cards || [];
      if (Date.now() >= revealAt) { dval = lr.dealer.blackjack ? "BJ" : lr.dealer.bust ? T("bust_v", "{v} bust", { v: lr.dealer.value }) : String(lr.dealer.value); dcls = lr.dealer.bust ? "bust" : lr.dealer.blackjack ? "bj" : ""; }
    } else if (dl.cards && dl.cards.length) {
      dcards = dl.cards.concat(dl.hidden ? ["??"] : []);
      dval = dl.hidden ? String(dl.value) : dl.blackjack ? "BJ" : String(dl.value);
      dcls = dl.bust ? "bust" : dl.blackjack ? "bj" : "";
    }
    const dbox = $("cz-dealer");
    const before = dbox.dataset.sig ? dbox.dataset.sig.split(",").length : 0;
    const added = CZ.drawCards(dbox, dcards, dealing ? { delay0: seatsN * 0.14, step: (seatsN + 1) * 0.14, fy: "-120px" }
                                                     : { delay0: 0.45, step: 0.55, flipDelay: 0, fy: "-120px" });
    // a settle just landed on the felt: hold the outcomes until Pepe's draws have been dealt
    if (resultMode && popRound !== lr.round_no) {
      revealAt = first || CZ.reduced ? 0 : Date.now() + (before && added ? 450 + added * 550 : 300);
      clearTimeout(revealTm);
      if (revealAt) revealTm = setTimeout(() => last && render(last), revealAt - Date.now() + 30);
    }
    const dv = $("cz-dval");
    dv.textContent = dval;
    dv.className = "val" + (dcls ? " " + dcls : "");

    // seats: left to right in play order; your own seat is outlined
    const els = slots();
    const hrv = !!(t.high_stakes || (me && me.high_roller));      // 1.99ov: 💎 chips for High Rollers and at High Roller tables
    $("cz-felt").classList.toggle("hr", !!t.high_stakes);
    const lrBy = new Map(((lr && lr.players) || []).map((p) => [p.name, p]));
    for (let i = 0; i < SEATS; i++) {
      const el = els[i], s = t.seats[i];
      const mine = !!(s && me && me.seat && s.seat === me.seat);
      el.className = "seat" + (s ? "" : " empty") + (mine ? " me" : "") + (s && s.turn ? " turn" : "");
      let hands = [];
      if (s) {
        if (resultMode) { const p = lrBy.get(s.name); hands = p ? p.hands.map((h) => ({ cards: h.cards, value: h.value, outcome: h.outcome, is_bj: h.is_bj, doubled: h.doubled })) : []; }
        else hands = s.hands;
      }
      if (dealing) { delay0 = i * 0.14; step = (seatsN + 1) * 0.14; } else { delay0 = 0; step = 0.14; }
      drawHands(el, hands, { delay0, step });
      const bet = s ? (resultMode ? 0 : s.hands.reduce((a, h) => a + (h.bet || 0), 0) || s.bet) : 0;
      const spot = el.querySelector(".betspot");
      const spotHTML = bet ? CZ.stackHTML(bet, T("bet_lbl", "Bet {n}", { n: fmt(bet) }), hrv) : s && s.pending ? `<span class="tag">${esc(T("next_n", "next {n}", { n: fmt(s.pending) }))}</span>` : "";
      if (spot.dataset.v !== spotHTML) { spot.dataset.v = spotHTML; spot.innerHTML = spotHTML; }
      spot.classList.toggle("on", !!bet);
      const who = el.querySelector(".who");
      let whoHTML;
      if (s) {
        const tags = [s.host ? `<span class="tag gold">👑 ${esc(T("host", "host"))}</span>` : "", s.via === "room" ? `<span class="tag blue">🐸 ${esc(T("camfrog", "Camfrog"))}</span>` : "",
                      s.autobet ? `<span class="tag">${esc(T("auto", "auto"))}</span>` : "", s.insured ? `<span class="tag green">${esc(T("insured", "insured"))}</span>` : "",
                      s.leaving ? `<span class="tag red">${esc(T("leaving", "leaving"))}</span>` : ""].join("");
        whoHTML = CZ.avatarHTML(s) + `<span class="plate"><span class="nm">${esc(s.name)}${mine ? " · " + esc(T("you", "you")) : ""}</span>` +
                  (tags ? `<span class="tags">${tags}</span>` : "") + "</span>";
      } else {
        const can = CZ.signed && me && !me.seat && !me.pending && open;
        whoHTML = can ? `<button type="button" class="sitbtn" data-sit="1"><span class="av" aria-hidden="true">+</span><span class="plate">${esc(T("open_seat_bet", "Open seat: bet to sit"))}</span></button>`
                      : `<span class="av" aria-hidden="true"></span><span class="plate">${esc(T("open_seat", "Open seat"))}</span>`;
      }
      whoHTML += `|${s && s.turn ? 1 : 0}`;
      if (who.dataset.v !== whoHTML) { who.dataset.v = whoHTML; who.innerHTML = whoHTML.slice(0, whoHTML.lastIndexOf("|")); }
      const av = who.querySelector(".av");
      if (av) CZ.armClock(av, s && s.turn && t.turn ? t.turn.deadline : null, t.act_secs);
    }

    // payout pops + a short announcement for your own result (once per round, never on the first load)
    if (resultMode && popRound !== lr.round_no) {
      const roundNo = lr.round_no;
      const firstSeen = first;
      popRound = roundNo;
      if (!firstSeen) {
        setTimeout(() => {
          if (!last || popRound !== roundNo) return;
          lr.players.forEach((p) => {
            const i = last.table.seats.findIndex((s) => s.name === p.name);
            if (i < 0) return;
            const bj = p.hands.some((h) => h.is_bj && h.outcome === "blackjack");
            CZ.pop(els[i], p.net > 0 ? (bj ? T("pop_bj", "Blackjack +{n}", { n: fmt(p.net) }) : "+" + fmt(p.net)) : p.net < 0 ? "−" + fmt(-p.net) : OUT("push"), p.net > 0 ? "win" : p.net < 0 ? "lose" : "push");
          });
          const mine = me && me.seat ? lr.players.find((p) => { const s = last.table.seats.find((x) => x.name === p.name); return s && s.seat === me.seat; }) : null;
          if (mine) CZ.announce(mine.net > 0 ? T("you_won", "You won {n} PAT.", { n: fmt(mine.net) }) : mine.net < 0 ? T("you_lost", "You lost {n} PAT.", { n: fmt(-mine.net) }) : T("you_push", "Push: your bet comes back."));
        }, Math.max(0, revealAt - Date.now()));
      }
    }

    // the message + the felt's clock (betting window, insurance, or whoever is acting)
    let msg = "", sub = "", dlx = null, nom = 0;
    if (!open) msg = T("closed", "That table has closed.");
    else if (betting) {
      msg = t.seats.length ? T("place_bets", "Place your bets") : T("bet_to_sit", "Bet to take a seat");
      sub = resultMode && Date.now() >= revealAt ? T("last_dealer", "Last round: Pepe {v}", { v: lr.dealer.blackjack ? "BJ" : lr.dealer.bust ? T("bust_v", "{v} bust", { v: lr.dealer.value }) : lr.dealer.value }) : "";
      dlx = t.bet_deadline; nom = t.round_no ? 10 : 30;
    } else if (t.phase === "insurance") { msg = T("ins_q", "Pepe shows an Ace: insurance?"); dlx = t.ins_deadline; nom = 18; }
    else if (t.turn) {
      const mineTurn = me && me.my_turn;
      msg = mineTurn ? T("your_turn", "Your turn") : T("to_act", "{name} to act", { name: t.turn.name });
      if (t.turn.num_hands > 1) sub = T("hand_x", "Hand {i} of {n}", { i: t.turn.hand_index + 1, n: t.turn.num_hands });
      dlx = t.turn.deadline; nom = t.act_secs;
    } else msg = T("pepe_plays", "Pepe plays his hand…");
    $("cz-msg").innerHTML = esc(msg) + (sub ? `<small>${esc(sub)}</small>` : "");
    CZ.armClock($("cz-fclock"), dlx, nom);
    const rs = t.rooms && t.rooms.length ? t.rooms.map((r) => r.name) : t.room ? [t.room_name || t.room] : [];       // 1.99ox: every room it plays in
    const where = rs.length ? `🐸 ${esc(rs.length > 1 ? T("in_rooms", "Camfrog rooms {rooms}", { rooms: rs.join(", ") }) : T("in_room", "Camfrog room {room}", { room: rs[0] }))}` : `🌐 ${esc(T("web_only", "Web only"))}`;
    const meta = [t.high_stakes ? `💎 ${esc(T("high_roller", "High Roller"))}` : "", `👑 ${esc(t.host)}`, where, t.round_no ? esc(T("round_n", "Round {n}", { n: t.round_no })) : "", esc(T("decks_n", "{n} decks", { n: t.decks })),
                  t.on_stream ? `📺 ${esc(T("on_stream", "On Pepe's stream"))}` : t.stream_queue ? `📺 ${esc(T("stream_q", "stream queue #{n}", { n: t.stream_queue }))}` : ""]
      .filter(Boolean).map((x, i) => `<span class="tag${i === 0 && t.high_stakes ? " hr" : ""}">${x}</span>`).join("");
    if ($("cz-meta").dataset.v !== meta) { $("cz-meta").dataset.v = meta; $("cz-meta").innerHTML = meta; }

    // spectators
    const wb = $("cz-watchbar");
    const seated = !!(me && (me.seat || me.pending));
    let wtxt = "";
    if (open && !CZ.signed) wtxt = `👁 ${esc(T("watching_signin", "You're watching."))} <a href="/login">${esc(T("signin_play", "Sign in to play"))}</a>`;
    else if (open && me && !seated && t.high_stakes && !me.high_roller) wtxt = `💎 ${esc(T("watching_hr", "A High Roller table: you're watching. Only High Rollers can bet here."))} <a href="/shop">${esc(T("hr_get", "Get the role"))}</a>`;
    else if (open && me && !seated) wtxt = `👁 ${esc(t.seats.length >= SEATS ? T("watching_full", "You're watching: the table is full.") : T("watching_bet", "You're watching. Place a bet below to take a seat."))}`;
    wb.hidden = !wtxt;
    if (wb.dataset.v !== wtxt) { wb.dataset.v = wtxt; wb.innerHTML = wtxt; }

    dock(t, me, betting);
    if (me && me.my_turn && !prevTurn) CZ.announce(T("your_turn_sr", "Your turn. Hit, stand, or more."));
    prevTurn = !!(me && me.my_turn);
    first = false;
  }

  // 1.99ov: the chips a bettor can add. Regular: 100 / 500 / 1K / 5K / 25K; the 💎 ones (100K / 500K / 1M / 5M) only for High
  // Rollers (and a High Roller table is played with them alone). Only chips up to the table maximum.
  const REG = [[100, ""], [500, "c500"], [1000, "c1k"], [5000, "c5k"], [25000, "c25k"]];
  const HRC = [[100000, "c100k hrc"], [500000, "c500k hrc"], [1000000, "c1m hrc"], [5000000, "c5m hrc"]];
  function chipRack(t, me) {
    let set = t.high_stakes ? HRC : REG.concat(me.high_roller ? HRC : []);
    set = set.filter(([v]) => v <= t.max_bet);
    if (t.high_stakes && !set.length) set = HRC.slice(0, 1);
    return set.slice(-6).concat([["max", "cmax"]]);
  }

  function dock(t, me, betting) {
    const dk = $("cz-dock");
    const open = t.status === "open";
    dk.hidden = !CZ.signed || !open || !me;
    if (dk.hidden) return;
    const maxAllowed = Math.max(0, Math.min(t.max_bet, me.balance));
    const hrLocked = !!t.high_stakes && !me.high_roller;           // 1.99ov: a High Roller table - others watch
    const inRound = !betting && t.seats.some((s) => me.seat && s.seat === me.seat && s.hands.length);
    const myTurn = !!(me.my_turn && t.turn);
    const playing = myTurn || me.can_insure;
    const showBet = !playing && !me.banned && !hrLocked && ((betting && !(me.bet > 0)) || (!betting && !inRound && !me.pending)) && (me.seat || t.seats.length < SEATS);
    $("cz-playbox").hidden = !playing;
    $("cz-betbox").hidden = !showBet;
    for (const b of document.querySelectorAll("#cz-playbox [data-v]")) {
      const v = b.dataset.v;
      if (v === "insurance") { b.hidden = !me.can_insure; b.textContent = T("ins_btn", "Insurance ({n})", { n: fmt(Math.floor((me.bet || 0) / 2)) }); continue; }
      b.hidden = !myTurn || (v === "double" && !t.turn.can_double) || (v === "split" && !t.turn.can_split);
    }
    CZ.armClock($("cz-dclock"), myTurn ? t.turn.deadline : me.can_insure ? t.ins_deadline : null, myTurn ? t.act_secs : 18);
    if (showBet) {
      if (stake > maxAllowed) stake = maxAllowed;
      $("cz-stake").textContent = fmt(stake);
      $("cz-stakelbl").textContent = betting ? T("your_bet", "Your bet") : T("next_bet", "Next round's bet");
      $("cz-limits").textContent = (t.high_stakes ? "💎 " : "") + T("limits", "Min {min} · max {max}", { min: fmt(t.min_bet), max: fmt(t.max_bet) }) +
                                   " · " + T("balance_n", "Balance {n}", { n: fmt(me.balance) });
      // the chip rack: the table's own range; High Rollers also get the 💎 chips (100K, 500K, 1M, 5M) that fit under the maximum
      const chips = $("cz-chips");
      const rack = chipRack(t, me);
      const sig = rack.map((c) => c[0]).join();
      if (chips.dataset.v !== sig) {
        chips.dataset.v = sig;
        chips.innerHTML = rack.map(([v, c]) =>
          `<button type="button" class="chipbtn${/hrc/.test(c) ? " hr" : ""}" data-add="${v}" aria-label="${esc(v === "max" ? T("chip_max", "Bet the most you can") : T("chip_add", "Add {n}", { n: fmt(v) }))}">` +
          `<span class="chip ${c}" aria-hidden="true"></span><span class="l">${esc(v === "max" ? T("max", "Max") : CZ.short(v))}</span></button>`).join("");
      }
      for (const b of chips.querySelectorAll("button")) b.disabled = b.dataset.add === "max" ? maxAllowed < t.min_bet : stake + Number(b.dataset.add) > maxAllowed;
      const bet = $("cz-bet");
      bet.textContent = betting ? T("bet_n", "Bet {n}", { n: fmt(stake) }) : T("bet_next_n", "Bet {n} next round", { n: fmt(stake) });
      bet.disabled = stake < t.min_bet || stake > maxAllowed;
      $("cz-clear").disabled = !stake;
      const rb = $("cz-rebet");
      const lb = me.lastbet || 0;
      rb.hidden = !(lb >= t.min_bet && lb <= maxAllowed);
      rb.textContent = T("rebet_n", "Rebet {n}", { n: fmt(lb) });
      const au = $("cz-auto");
      au.setAttribute("aria-pressed", String(!!me.autobet));
      au.textContent = me.autobet ? T("autobet_on", "Autobet: on") : T("autobet", "Autobet");
      if (focusBet) { focusBet = false; const c = chips.querySelector("button:not([disabled])"); if (c) c.focus(); }
    }
    let wait = "";
    if (me.banned) wait = T("banned", "You're banned from the casino.");
    else if (hrLocked && !me.seat) wait = T("hr_watch_note", "💎 High Rollers only: watch the table above.");
    else if (!playing && !showBet) {
      if (betting && me.bet > 0) wait = T("in_for", "You're in for {n}. Pepe deals when the clock runs out.", { n: fmt(me.bet) });
      else if (me.pending) wait = T("in_next", "You're in next round for {n}.", { n: fmt(me.pending) });
      else if (t.turn) wait = T("waiting_for", "Waiting for {name}…", { name: t.turn.name });
      else if (!betting) wait = T("pepe_plays", "Pepe plays his hand…");
    }
    $("cz-wait").hidden = !wait;
    $("cz-wait").textContent = wait;
    $("cz-deal").hidden = !(betting && me.bet > 0);
    $("cz-autooff").hidden = !me.autobet || showBet;
    $("cz-leave").hidden = !(me.seat || me.pending);
  }

  // ── wiring ──
  $("cz-chips").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-add]");
    if (!b || !last || !last.me) return;
    const t = last.table, me = last.me;
    const maxAllowed = Math.min(t.max_bet, me.balance);
    stake = b.dataset.add === "max" ? maxAllowed : Math.min(maxAllowed, stake + Number(b.dataset.add));
    render(last);
  });
  $("cz-clear").addEventListener("click", () => { stake = 0; if (last) render(last); });
  $("cz-bet").addEventListener("click", async () => { const j = await act("bet", stake); if (j && j.ok) stake = 0; });
  $("cz-rebet").addEventListener("click", () => last && act("bet", last.me.lastbet));
  $("cz-auto").addEventListener("click", () => last && act("autobet", last.me.autobet ? "off" : stake || last.me.lastbet || last.table.min_bet));
  $("cz-autooff").addEventListener("click", () => act("autobet", "off"));
  $("cz-deal").addEventListener("click", () => act("deal"));
  $("cz-leave").addEventListener("click", () => act("leave"));
  for (const b of document.querySelectorAll("#cz-playbox [data-v]")) b.addEventListener("click", () => act(b.dataset.v));
  $("cz-seats").addEventListener("click", (e) => {
    if (!e.target.closest("[data-sit]")) return;
    const c = document.querySelector("#cz-chips button:not([disabled])");
    if (c) { c.scrollIntoView({ block: "nearest" }); c.focus(); }
  });
  // keyboard: H / S / D / P on your turn (not while typing)
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || /input|select|textarea/i.test((e.target && e.target.tagName) || "")) return;
    if (!last || !last.me || !last.me.my_turn) return;
    const v = { h: "hit", s: "stand", d: "double", p: "split" }[e.key.toLowerCase()];
    const b = v && document.querySelector(`#cz-playbox [data-v="${v}"]`);
    if (b && !b.hidden && !b.disabled) { e.preventDefault(); b.click(); }
  });
  $("cz-histbtn").addEventListener("click", () => {
    CZ.openSheet("cz-histsheet");
    CZ.loadHistory((r) => {
      const x = r.results;
      const dlr = x.dealer || {};
      return `<div class="hh"><b>${esc(T("round_n", "Round {n}", { n: r.round }))}</b><a href="${esc(r.proof)}">🔐 ${esc(T("verify", "verify"))}</a></div>` +
        `<div class="pl"><b>${esc(T("dealer", "Pepe"))}</b>${CZ.staticCards(dlr.cards)}<span class="val">${dlr.blackjack ? "BJ" : esc(String(dlr.value))}${dlr.bust ? " " + esc(T("bust", "bust")) : ""}</span></div>` +
        (x.players || []).map((p) => `<div class="pl"><b>${esc(p.name)}</b>` + p.hands.map((h) => `${CZ.staticCards(h.cards)}<span class="oc ${esc(h.outcome)}">${esc(OUT(h.outcome))}</span>`).join(" ") +
          `${CZ.net(p.net)}</div>`).join("");
    });
  });
  CZ.wireHost(() => ref.fn && ref.fn(), () => act("end"));
  const refresh = CZ.startTable(render);
  ref.fn = refresh;
})();
