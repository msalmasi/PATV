// casinohm.js — the web Hold'em table (/casino/holdem/t/<id>; the lobby is casino-ui.js). D10 design pass, 2026-10-11.
// Draws the oval felt from /api/casino/t/<id> (polled about once a second by casino-ui.js): nine seats with you at the bottom
// (rotated, so the action still goes round in table order), the dealer button and blinds, bets in front of the seats, the
// board and the pot (main pot / side pots / uncalled bet spelled out), YOUR hole cards (only ever in your own `me` part,
// face down for everyone else), the showdown reveal and winner pops, an action bar with a bet slider + presets and a
// countdown ring on the server's deadline, and the buy-in / top-up sheet. Moves post with an idempotency key.
(function () {
  "use strict";
  const CZ = window.CZ;
  if (!CZ) return;
  const { $, T, esc, fmt } = CZ;
  if (!CZ.tableId) { CZ.startLobby(); return; }

  const SLOTS = 9;
  const ref = {};
  const act = CZ.actor(ref);
  let last = null, drawnHand = null, popHand = null, first = true, prevTurn = false, raiseTouched = false, buyMode = "sit",
      wantSit = /[?&]sit=1/.test(location.search);

  const potName = (p) => { const m = /^side pot (\d+)$/.exec(String(p || "")); return m ? T("side_pot_n", "side pot {n}", { n: m[1] }) : p === "main pot" ? T("main_pot", "main pot") : p === "pot" ? T("the_pot", "the pot") : String(p || ""); };
  const handName = (h) => (h === "everyone folded" ? T("all_folded", "everyone folded") : h);

  function build() {
    const seats = $("cz-seats"), bets = $("cz-bets");
    if (seats.children.length !== SLOTS) {
      seats.innerHTML = Array.from({ length: SLOTS }, (_, i) => `<div class="seat hm-seat p${i}" data-slot="${i}"><div class="hole"></div><div class="who"></div></div>`).join("");
      bets.innerHTML = Array.from({ length: SLOTS }, (_, i) => `<div class="hm-bet b${i}" data-slot="${i}" hidden></div>`).join("");
    }
    const b = $("cz-board");
    if (!b.children.length) b.innerHTML = '<span class="cards row" id="cz-boardcards"></span>';
    return { seats: Array.from(seats.children), bets: Array.from(bets.children) };
  }

  function render(d) {
    const t = d.table, me = d.me;
    last = d;
    const open = t.status === "open";
    const inHand = t.phase !== "between" && t.phase !== "closed";
    const lr = !inHand ? t.last_round : null;
    const els = build();
    // a new hand: clear the felt so its cards are dealt in
    const handNo = inHand ? t.hand_no : lr ? lr.hand_no : null;
    let dealing = false;
    if (handNo !== drawnHand) {
      for (const h of document.querySelectorAll("#cz-seats .hole")) { h.textContent = ""; delete h.dataset.sig; }
      const bc = $("cz-boardcards");
      bc.textContent = ""; delete bc.dataset.sig;
      dealing = !first && inHand;
      drawnHand = handNo;
    }
    // you sit at the bottom; everyone else keeps table order round the felt
    const myIdx = me && me.seat ? t.seats.findIndex((s) => s.seat === me.seat) : -1;
    const slotOf = (i) => (myIdx >= 0 ? (i - myIdx + SLOTS) % SLOTS : i);
    const bySlot = new Array(SLOTS).fill(null);
    t.seats.forEach((s, i) => { bySlot[slotOf(i)] = s; });
    const n = Math.max(1, t.seats.length);
    const hrv = !!(t.high_stakes || (me && me.high_roller));      // 1.99ov: 💎 chips for High Rollers and at High Roller tables
    const hrLocked = !!t.high_stakes && !(me && me.high_roller);   // a High Roller table: everyone else watches
    $("cz-felt").classList.toggle("hr", !!t.high_stakes);
    for (let k = 0; k < SLOTS; k++) {
      const s = bySlot[k], el = els.seats[k], bet = els.bets[k];
      const mine = !!(s && me && me.seat && s.seat === me.seat);
      el.className = `seat hm-seat p${k}` + (s ? "" : " empty") + (mine ? " me" : "") + (s && s.turn ? " turn" : "") +
                     (s && s.status === "folded" ? " folded" : "") + (s && s.winner ? " winner" : "");
      // hole cards: your own from `me`, a showdown's shown cards, otherwise two backs while the seat is in the hand
      let cards = [];
      if (s) {
        if (mine && me.cards && inHand) cards = me.cards;
        else if (s.shown) cards = s.shown;
        else if (s.cards_down) cards = ["??", "??"];
      }
      const order = t.seats.indexOf(s);
      CZ.drawCards(el.querySelector(".hole"), cards, dealing ? { delay0: order * 0.12, step: n * 0.12, fx: "0px", fy: "-140px", flip: mine }
                                                            : { delay0: 0, step: 0.12, flipDelay: 0 });
      const who = el.querySelector(".who");
      let html;
      if (s) {
        const tags = [s.status === "allin" ? `<span class="tag red">${esc(T("allin", "all-in"))}</span>` : "", s.status === "folded" ? `<span class="tag">${esc(T("folded", "folded"))}</span>` : "",
                      s.status === "waiting" && inHand ? `<span class="tag">${esc(T("next_hand", "next hand"))}</span>` : "",
                      s.via === "room" ? '<span class="tag blue">🐸</span>' : "", s.host ? '<span class="tag gold">👑</span>' : "",
                      s.leaving ? `<span class="tag red">${esc(T("leaving", "leaving"))}</span>` : ""].join("");
        html = CZ.avatarHTML(s) + (s.button ? `<span class="dbtn" title="${esc(T("dealer_btn", "Dealer button"))}">D</span>` : "") +
               `<span class="plate"><span class="nm">${esc(s.name)}</span><span class="sub">${fmt(s.stack)}</span></span>` +
               (tags ? `<span class="st">${tags}</span>` : "") + (s.hand ? `<span class="hand">${esc(handName(s.hand))}</span>` : "");
      } else {
        const can = CZ.signed && me && !me.seat && open && t.seats.length < t.max_seats && !hrLocked;
        html = can ? `<button type="button" class="sitbtn" data-sit="1"><span class="av" aria-hidden="true">+</span><span class="plate">${esc(T("sit", "Sit"))}</span></button>`
                   : `<span class="av" aria-hidden="true"></span><span class="plate">${esc(T("open_seat", "Open seat"))}</span>`;
      }
      const key = html + `|${s && s.turn ? 1 : 0}`;
      if (who.dataset.v !== key) { who.dataset.v = key; who.innerHTML = html; }
      el.setAttribute("aria-label", s ? T("seat_lbl", "{name}, stack {n}", { name: s.name, n: fmt(s.stack) }) + (s.turn ? " · " + T("acting", "acting") : "") : T("open_seat", "Open seat"));
      const av = who.querySelector(".av");
      if (av) CZ.armClock(av, s && s.turn && t.turn ? t.turn.deadline : null, t.act_secs);
      // the bet in front of the seat (with its blind)
      const bhtml = s && s.bet ? (s.blind ? `<span class="bl">${esc(s.blind)}</span>` : "") + CZ.stackHTML(s.bet, "", hrv) : "";
      bet.hidden = !bhtml;
      if (bet.dataset.v !== bhtml) { bet.dataset.v = bhtml; bet.innerHTML = bhtml; }
    }

    // the board: five places, cards dealt in (and turned over) as the streets come
    const board = inHand ? t.board : lr ? lr.board || [] : [];
    const bc = $("cz-boardcards");
    CZ.drawCards(bc, board, { flip: true, step: 0.18, fy: "-30px" });
    $("cz-board").dataset.n = board.length;
    // placeholders for the streets still to come
    let ph = $("cz-board").querySelector(".slots");
    if (!ph) { ph = document.createElement("span"); ph.className = "cards row slots"; ph.setAttribute("aria-hidden", "true"); $("cz-board").appendChild(ph); }
    const want = Math.max(0, 5 - board.length);
    if (ph.children.length !== want) ph.innerHTML = '<span class="pc slot"><span class="pc-in"><span class="pc-f"></span></span></span>'.repeat(want);

    // the pot: the total, then main pot / side pots / the part nobody has called yet
    let pot = "";
    if (inHand && t.pot) {
      const pots = t.pots || [];
      // One clear total. Mid-street the bets sit in front of the seats, and the only extra line is the part of the top bet
      // nobody has matched yet ("25 not called yet" for the big blind) - the engine's provisional levels aren't side pots
      // until the street is over. Once the bets are in the middle and someone is all-in: main pot + side pots.
      const parts = [];
      const streetBets = t.seats.some((s) => s.bet > 0);
      const allin = t.seats.some((s) => s.status === "allin");
      const lastPot = pots[pots.length - 1];
      if (streetBets) {
        if (lastPot && lastPot.players <= 1 && pots.length > 1) parts.push(`<span class="tag unc">${esc(T("uncalled_n", "{n} not called yet", { n: fmt(lastPot.amount) }))}</span>`);
      } else if (allin && pots.length > 1) {
        let side = 0;
        pots.forEach((p, i) => {
          if (p.players <= 1) parts.push(`<span class="tag unc">${esc(T("returned_n", "{n} goes back (uncalled)", { n: fmt(p.amount) }))}</span>`);
          else parts.push(`<span class="tag">${esc(i === 0 ? T("main_n", "Main pot {n}", { n: fmt(p.amount) }) : T("side_n", "Side pot {i}: {n}", { i: ++side, n: fmt(p.amount) }))}</span>`);
        });
      }
      pot = `<span class="main${hrv && t.pot >= 100000 ? " hr" : ""}">${CZ.pileHTML(t.pot, hrv)}${esc(T("pot_n", "Pot {n}", { n: fmt(t.pot) }))}</span>` +
            (parts.length ? `<span class="parts">${parts.join("")}</span>` : "");
    } else if (lr) {
      pot = `<div class="hm-res">` + lr.winners.map((w) => esc(T("wins_line", "{name} wins {n}", { name: w.name, n: fmt(w.amount) })) +
            (w.hand ? ` · ${esc(handName(w.hand))}` : "") + (lr.winners.length > 1 ? ` (${esc(potName(w.pot))})` : "")).map((x) => `<b>${x}</b>`).join("<br>") +
            (lr.rake ? `<br>${esc(T("rake_n", "Rake {n} to the House", { n: fmt(lr.rake) }))}` : "") + "</div>";
    }
    const potEl = $("cz-pot");
    if (potEl.dataset.v !== pot) { potEl.dataset.v = pot; potEl.innerHTML = pot; }

    // winner pops (once per hand, not on the first load)
    if (lr && popHand !== lr.hand_no) {
      const was = first;
      popHand = lr.hand_no;
      if (!was) {
        const delay = CZ.reduced ? 0 : 700;
        setTimeout(() => {
          for (const w of lr.winners) {
            const k = bySlot.findIndex((s) => s && s.name === w.name);
            if (k >= 0) CZ.pop(els.seats[k], "+" + fmt(w.amount), "win");
          }
          const mineW = me && me.seat ? lr.winners.find((w) => { const s = t.seats.find((x) => x.name === w.name); return s && s.seat === me.seat; }) : null;
          if (mineW) CZ.announce(T("you_won_pot", "You won {n}.", { n: fmt(mineW.amount) }));
        }, delay);
      }
    }

    // message + clock
    let msg = "", sub = "", dl = null, nom = 0;
    if (!open) msg = T("closed", "That table has closed.");
    else if (t.turn) {
      const mineTurn = me && me.my_turn;
      msg = mineTurn ? T("your_turn", "Your turn") : T("to_act", "{name} to act", { name: t.turn.name });
      sub = CZ.streetName(t.phase) + (t.turn.to_call ? " · " + T("to_call_n", "{n} to call", { n: fmt(t.turn.to_call) }) : "");
      dl = t.turn.deadline; nom = t.act_secs;
    } else if (!inHand) {
      if (t.next_at) { msg = T("next_soon", "Next hand soon"); dl = t.next_at; nom = 15; }
      else msg = t.seats.length < 2 ? T("need_two", "Waiting for a second player") : T("ready_deal", "Ready: anyone seated can deal");
    }
    $("cz-msg").innerHTML = esc(msg) + (sub ? `<small>${esc(sub)}</small>` : "");
    CZ.armClock($("cz-fclock"), dl, nom);
    const where = t.room ? `🐸 ${esc(T("in_room", "Camfrog room {room}", { room: t.room_name || t.room }))}` : `🌐 ${esc(T("web_only", "Web only"))}`;
    const meta = [t.high_stakes ? `💎 ${esc(T("high_roller", "High Roller"))}` : "", `👑 ${esc(t.host)}`, esc(T("blinds_v", "Blinds {sb}/{bb}", { sb: fmt(t.sb), bb: fmt(t.bb) })), where,
                  t.hand_no ? esc(T("hand_n", "Hand #{n}", { n: t.hand_no })) : "",
                  esc(T("rake_pct", "{n}% rake at showdown", { n: t.rake_pct })),
                  t.on_stream ? `📺 ${esc(T("on_stream", "On Pepe's stream"))}` : t.stream_queue ? `📺 ${esc(T("stream_q", "stream queue #{n}", { n: t.stream_queue }))}` : ""]
      .filter(Boolean).map((x, i) => `<span class="tag${i === 0 && t.high_stakes ? " hr" : ""}">${x}</span>`).join("");
    if ($("cz-meta").dataset.v !== meta) { $("cz-meta").dataset.v = meta; $("cz-meta").innerHTML = meta; }

    const wb = $("cz-watchbar");
    let wtxt = "";
    if (open && !CZ.signed) wtxt = `👁 ${esc(T("watching_hm", "You're watching. Hole cards stay hidden until a showdown."))} <a href="/login">${esc(T("signin_play", "Sign in to play"))}</a>`;
    else if (open && me && !me.seat && hrLocked) wtxt = `💎 ${esc(T("watching_hr_hm", "A High Roller table: you're watching. Only High Rollers can sit here."))} <a href="/shop">${esc(T("hr_get", "Get the role"))}</a>`;
    else if (open && me && !me.seat) wtxt = `👁 ${esc(t.seats.length >= t.max_seats ? T("watching_full", "You're watching: the table is full.") : T("watching_sit", "You're watching. Take an open seat to play."))}`;
    wb.hidden = !wtxt;
    if (wb.dataset.v !== wtxt) { wb.dataset.v = wtxt; wb.innerHTML = wtxt; }

    dock(t, me, inHand);
    if (me && me.my_turn && !prevTurn) { CZ.announce(T("your_turn_sr_hm", "Your turn. {n} to call.", { n: fmt(t.turn ? t.turn.to_call : 0) })); raiseTouched = false; }
    prevTurn = !!(me && me.my_turn);
    if (wantSit && me && open) { wantSit = false; if (!me.seat && t.seats.length < t.max_seats && !hrLocked) openBuy("sit"); }
    first = false;
  }

  // ── the chip rack (1.99ov): tap a chip to add it to your bet / raise. Regular chips from the big blind up; the 💎 ones
  // (100K / 500K / 1M / 5M) only for High Rollers and at High Roller tables. At most six, the ones that fit your stack.
  const RACK = [[25, ""], [100, ""], [500, "c500"], [1000, "c1k"], [5000, "c5k"], [25000, "c25k"]];
  const RACK_HR = [[100000, "c100k hrc"], [500000, "c500k hrc"], [1000000, "c1m hrc"], [5000000, "c5m hrc"]];
  function rackFor(t, me) {
    const hr = !!(t.high_stakes || me.high_roller);
    const { max } = raiseBounds(t);
    let set = (t.high_stakes ? RACK_HR : RACK.concat(hr ? RACK_HR : [])).filter(([v]) => v >= t.bb && v <= max);
    if (!set.length) set = (t.high_stakes ? RACK_HR : RACK).slice(0, 1);
    set = set.slice(0, 6);
    const box = $("cz-rack");
    const sig = set.map((c) => c[0]).join();
    if (box.dataset.v !== sig) {
      box.dataset.v = sig;
      box.innerHTML = set.map(([v, c]) => `<button type="button" class="rchip${/hrc/.test(c) ? " hr" : ""}" data-add="${v}" aria-label="${esc(T("chip_add", "Add {n}", { n: fmt(v) }))}">` +
        `<span class="chip ${c}" aria-hidden="true"></span><span class="l">${esc(CZ.short(v))}</span></button>`).join("");
    }
  }

  // ── raise sizing ──
  function raiseBounds(t) { return { min: Math.min(t.turn.min_to, t.turn.max_to), max: t.turn.max_to }; }
  function preset(p) {
    const t = last.table, tr = t.turn;
    const { min, max } = raiseBounds(t);
    const potAfterCall = t.pot + tr.to_call;
    let v = p === "min" ? min : p === "all" ? max : tr.current_bet + Math.round(potAfterCall * (p === "half" ? 0.5 : 1));
    return Math.max(min, Math.min(max, v));
  }
  function setRaise(v) {
    const t = last.table;
    const { min, max } = raiseBounds(t);
    v = Math.max(min, Math.min(max, Math.trunc(Number(v) || min)));
    $("cz-slider").value = String(v);
    $("cz-raise").value = String(v);
    const all = v >= max;
    $("cz-playbox").querySelector('[data-v="raise"]').textContent = all ? T("allin_n", "All-in {n}", { n: fmt(v) })
      : t.current_bet ? T("raise_to_n", "Raise to {n}", { n: fmt(v) }) : T("bet_n", "Bet {n}", { n: fmt(v) });
  }

  function dock(t, me, inHand) {
    const dk = $("cz-dock");
    const open = t.status === "open";
    dk.hidden = !CZ.signed || !open || !me;
    if (dk.hidden) return;
    const myTurn = !!(me.my_turn && t.turn);
    // your cards, big, in the dock (only yours ever reach this page)
    const showMine = !!(me.cards && inHand);
    $("cz-minerow").hidden = !showMine;
    if (showMine) CZ.drawCards($("cz-mine"), me.cards, { deal: false });
    $("cz-mine").classList.toggle("dim", !!me.folded);
    $("cz-playbox").hidden = !myTurn;
    CZ.armClock($("cz-dclock"), myTurn ? t.turn.deadline : null, t.act_secs);
    if (myTurn) {
      const tr = t.turn;
      const box = $("cz-playbox");
      box.querySelector('[data-v="check"]').hidden = !tr.can_check;
      const call = box.querySelector('[data-v="call"]');
      call.hidden = tr.can_check;
      call.textContent = tr.to_call >= (me.stack || 0) ? T("call_allin_n", "Call all-in {n}", { n: fmt(me.stack) }) : T("call_n", "Call {n}", { n: fmt(tr.to_call) });
      const canRaise = tr.can_raise && tr.max_to > tr.current_bet;
      box.querySelector('[data-v="raise"]').hidden = !canRaise;
      $("cz-raisebox").hidden = !canRaise;
      if (canRaise) {
        const { min, max } = raiseBounds(t);
        const s = $("cz-slider");
        s.min = String(min); s.max = String(max); s.step = String(Math.max(1, Math.min(t.bb, Math.floor((max - min) / 50) || 1)));
        if (!raiseTouched || Number($("cz-raise").value) < min || Number($("cz-raise").value) > max) setRaise(min);
        else setRaise($("cz-raise").value);
        rackFor(t, me);
      }
    }
    let wait = "";
    if (me.banned) wait = T("banned", "You're banned from the casino.");
    else if (me.leaving) wait = T("leaving_note", "You'll be cashed out when this hand ends.");
    else if (me.seat && inHand && !myTurn) wait = me.in_hand ? (me.folded ? T("folded_note", "You folded. Next hand soon.") : t.turn ? T("waiting_for", "Waiting for {name}…", { name: t.turn.name }) : "")
                                                              : T("join_next", "You're in from the next hand.");
    else if (me.seat && !inHand) wait = T("stack_n", "Your stack: {n}", { n: fmt(me.stack) }) + " · " + T("balance_n", "Balance {n}", { n: fmt(me.balance) });
    else if (!me.seat && t.high_stakes && !me.high_roller) wait = T("hr_watch_note", "💎 High Rollers only: watch the table above.");
    else if (!me.seat) wait = T("buy_note", "Buy in for {min}–{max} chips (chips = PAT).", { min: fmt(t.min_buy), max: fmt(t.max_buy) });
    $("cz-wait").hidden = !wait;
    $("cz-wait").textContent = wait;
    const full = t.seats.length >= t.max_seats;
    $("cz-sit").hidden = !!me.seat || full || me.banned || (!!t.high_stakes && !me.high_roller);
    $("cz-deal").hidden = !(me.seat && !inHand && t.seats.filter((s) => s.stack > 0).length >= 2);
    $("cz-topup").hidden = !(me.seat && !inHand && me.stack + t.min_buy <= t.max_buy);
    $("cz-leave").hidden = !me.seat || me.leaving;
  }

  // ── buy-in / top-up sheet ──
  function buyBounds() {
    const t = last.table, me = last.me;
    const min = t.min_buy;
    const max = buyMode === "top" ? t.max_buy - (me.stack || 0) : t.max_buy;
    return { min, max: Math.max(min, max), bal: me.balance };
  }
  function setBuy(v) {
    const { min, max, bal } = buyBounds();
    const sliderMax = max;
    v = Math.max(min, Math.min(max, Math.trunc(Number(v) || min)));
    const s = $("cz-buyslider");
    s.min = String(min); s.max = String(sliderMax); s.step = String(Math.max(1, last.table.bb));
    s.value = String(Math.min(v, sliderMax));
    $("cz-buyin").value = String(v);
    $("cz-buyamt").textContent = fmt(v);
    const go = $("cz-buygo");
    go.textContent = buyMode === "top" ? T("top_up_n", "Top up {n}", { n: fmt(v) }) : T("buy_in_n", "Buy in for {n}", { n: fmt(v) });
    go.disabled = v > bal;
    $("cz-buynote").textContent = (buyMode === "top" ? T("top_note", "Adds chips to your stack between hands. Max stack {max}.", { max: fmt(last.table.max_buy) })
                                                     : T("buy_range_t", "Blinds {sb}/{bb}: buy in for {min}–{max} chips (20–200 big blinds).", { sb: fmt(last.table.sb), bb: fmt(last.table.bb), min: fmt(last.table.min_buy), max: fmt(last.table.max_buy) })) +
                                  " " + T("balance_n", "Balance {n}", { n: fmt(bal) }) + (v > bal ? " · " + T("not_enough", "not enough PAT") : "");
  }
  function openBuy(mode) {
    if (!last || !last.me) return;
    buyMode = mode;
    $("cz-buy-h").textContent = mode === "top" ? T("top_up", "Top up") : T("buy_in", "Buy in");
    $("cz-buyhr").hidden = !last.table.high_stakes;
    const t = last.table;
    const bb100 = t.bb * 100;
    const { min, max } = buyBounds();
    const opts = [[T("bb_n", "{n} BB", { n: 20 }), min], [T("bb_n", "{n} BB", { n: 100 }), Math.min(max, Math.max(min, mode === "top" ? bb100 - last.me.stack : bb100))],
                  [T("max", "Max"), Math.min(max, mode === "top" ? t.max_buy - last.me.stack : t.max_buy)]];
    $("cz-buypresets").innerHTML = opts.map(([l, v]) => `<button type="button" data-v="${Math.max(min, v)}">${esc(l)}</button>`).join("");
    setBuy(mode === "top" ? min : Math.min(max, Math.max(min, bb100)));
    CZ.openSheet("cz-buy");
  }

  // ── wiring ──
  for (const b of document.querySelectorAll("#cz-playbox [data-v]")) {
    b.addEventListener("click", () => {
      const v = b.dataset.v;
      if (v !== "raise") return act(v);
      const t = last.table, amt = Number($("cz-raise").value);
      if (amt >= t.turn.max_to) return act("allin");
      return act(t.current_bet ? "raise" : "bet", amt);
    });
  }
  $("cz-slider").addEventListener("input", (e) => { raiseTouched = true; setRaise(e.target.value); });
  $("cz-raise").addEventListener("change", (e) => { raiseTouched = true; setRaise(e.target.value); });
  $("cz-rack").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-add]");
    if (!b || !last || !last.table.turn) return;
    const cur = raiseTouched ? Number($("cz-raise").value) || 0 : last.table.turn.current_bet;
    raiseTouched = true;
    setRaise(cur + Number(b.dataset.add));
  });
  $("cz-presets").addEventListener("click", (e) => { const b = e.target.closest("button[data-p]"); if (b && last && last.table.turn) { raiseTouched = true; setRaise(preset(b.dataset.p)); } });
  $("cz-sit").addEventListener("click", () => openBuy("sit"));
  $("cz-topup").addEventListener("click", () => openBuy("top"));
  $("cz-seats").addEventListener("click", (e) => { if (e.target.closest("[data-sit]")) openBuy("sit"); });
  $("cz-buyslider").addEventListener("input", (e) => setBuy(e.target.value));
  $("cz-buyin").addEventListener("change", (e) => setBuy(e.target.value));
  $("cz-buypresets").addEventListener("click", (e) => { const b = e.target.closest("button[data-v]"); if (b) setBuy(b.dataset.v); });
  $("cz-buygo").addEventListener("click", async () => {
    const j = await act("sit", Number($("cz-buyin").value));
    if (j && j.ok) { CZ.closeSheet("cz-buy"); CZ.toast(buyMode === "top" ? T("topped", "Chips added.") : T("seated", "You're seated. Good luck!"), false); }
  });
  $("cz-deal").addEventListener("click", () => act("deal"));
  $("cz-leave").addEventListener("click", () => act("stand"));
  // keyboard on your turn: F fold, C check / call, R raise (not while typing)
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || /input|select|textarea/i.test((e.target && e.target.tagName) || "")) return;
    if (!last || !last.me || !last.me.my_turn) return;
    const k = e.key.toLowerCase();
    const sel = k === "f" ? '[data-v="fold"]' : k === "c" ? '[data-v="check"]:not([hidden]), [data-v="call"]:not([hidden])' : k === "r" ? '[data-v="raise"]' : null;
    const b = sel && document.querySelector("#cz-playbox " + sel.split(", ").join(", #cz-playbox "));
    if (b && !b.hidden && !b.disabled) { e.preventDefault(); b.click(); }
  });
  $("cz-histbtn").addEventListener("click", () => {
    CZ.openSheet("cz-histsheet");
    CZ.loadHistory((r) => {
      const x = r.results;
      return `<div class="hh"><b>${esc(T("hand_n", "Hand #{n}", { n: r.round }))}</b><span>${x.rake ? esc(T("rake_n", "Rake {n} to the House", { n: fmt(x.rake) })) : esc(T("no_rake", "No rake"))} · ` +
        `<a href="${esc(r.proof)}">🔐 ${esc(T("verify", "verify"))}</a></span></div>` +
        (x.board && x.board.length ? `<div class="pl">${esc(T("board", "Board"))} ${CZ.staticCards(x.board)}</div>` : "") +
        (x.shown || []).map((s) => `<div class="pl"><b>${esc(s.name)}</b>${CZ.staticCards(s.cards)}<span>${esc(handName(s.hand))}</span></div>`).join("") +
        (x.winners || []).map((w) => `<div class="pl">🏆 <b>${esc(w.name)}</b> ${CZ.net(w.amount)} <span>${esc(potName(w.pot))}${w.hand ? " · " + esc(handName(w.hand)) : ""}</span></div>`).join("") +
        `<div class="pl" style="color:var(--mut)">${esc(T("pot_n", "Pot {n}", { n: fmt(x.pot) }))}</div>`;
    });
  });
  CZ.wireHost(() => ref.fn && ref.fn(), () => act("end"));
  ref.fn = CZ.startTable(render);
})();
