// casinohm.js — the web Hold'em table (/casino/holdem/t/<id>; the lobby is casino-ui.js). D10 design pass, 2026-10-11.
// Draws the oval felt from /api/casino/t/<id> (polled about once a second by casino-ui.js): nine seats with you at the bottom
// (rotated, so the action still goes round in table order), the dealer button and blinds, bets in front of the seats, the
// board and the pot (main pot / side pots / uncalled bet spelled out), YOUR hole cards (only ever in your own `me` part,
// face down for everyone else), the showdown reveal and winner pops, an action bar with a bet slider + presets and a
// countdown ring on the server's deadline, pre-moves, sizing grammar, sit-out and time-bank controls.
// Buy-in / top-up and every move post with an idempotency key. My hands replays only your completed hands.
// h22 (1.99alz): at a 🏁 Sit & Go (table.tourney) the header above the felt shows the level, the blinds, the time to the next level,
// the players left and the prize table (while it registers: who's in, the countdown, Register / Unregister), the results card the end;
// there is no buy-in, top-up, stand-up or deal button there (tournament chips aren't PAT).
// 1.99?? h20: a themed table (t.theme) is dressed by CZ.theme (casino-ui.js) - the look only.
(function () {
  "use strict";
  const CZ = window.CZ;
  if (!CZ) return;
  const { $, T, esc, fmt } = CZ;
  if (!CZ.tableId) { CZ.startLobby(); return; }
  if (window.matchMedia && window.matchMedia("(max-width: 600px)").matches) $("cz-raisebox").open = false;

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
    const tn = t.tourney || null;                    // h22: a sit & go's table
    last = d;
    sngHead(t, me);
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
    CZ.theme(t, { scene: $("cz-felt").parentNode, sign: $("cz-seats") });    // 1.99?? h20: the table's theme (casino-ui.js; the sign on the felt itself)
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
                      s.leaving ? `<span class="tag red">${esc(T("leaving", "leaving"))}</span>` : "",
                      s.sitting_out ? `<span class="tag">⏸ ${esc(T("sitting_out", "Sitting out"))}</span>` : s.waiting_bb ? `<span class="tag">${esc(T("waiting_bb", "Waiting for big blind"))}</span>` : "",
                      `<span class="tag">${esc(T("bank_n", "Bank {n}s", { n: Math.ceil(s.bank_secs || 0) }))}</span>`].join("");
        // (1.99ajw casino2: the avatar + plate open the person menu - CZ.seatWho makes them a button when that seat has one)
        html = CZ.seatWho(s, CZ.avatarHTML(s) + `<span class="plate"><span class="nm">${esc(s.name)}</span><span class="sub">${fmt(s.stack)}</span></span>`) +
               (s.button ? `<span class="dbtn" title="${esc(T("dealer_btn", "Dealer button"))}">D</span>` : "") +
               (tags ? `<span class="st">${tags}</span>` : "") + (s.hand ? `<span class="hand">${esc(handName(s.hand))}</span>` : "");
      } else {
        const can = !tn && CZ.signed && me && !me.seat && open && t.seats.length < t.max_seats && !hrLocked;
        html = can ? `<button type="button" class="sitbtn" data-sit="1"><span class="av" aria-hidden="true">+</span><span class="plate">${esc(T("sit", "Sit"))}</span></button>`
                   : `<span class="av" aria-hidden="true"></span><span class="plate">${esc(T("open_seat", "Open seat"))}</span>`;
      }
      const key = html + `|${s && s.turn ? 1 : 0}`;
      if (who.dataset.v !== key) { who.dataset.v = key; who.innerHTML = html; }
      el.setAttribute("aria-label", s ? T("seat_lbl", "{name}, stack {n}", { name: s.name, n: fmt(s.stack) }) + (s.turn ? " · " + T("acting", "acting") : "") : T("open_seat", "Open seat"));
      const av = who.querySelector(".av");
      if (av) { CZ.armClock(av, s && s.turn && t.turn ? t.turn.deadline : null, t.act_secs); av.classList.toggle("banking", !!(s && s.turn && t.turn && t.turn.banking)); }
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
        // (1.99ajw casino2 rework: a winner is matched to its seat by seat id - two masked seats can both read "someone" - an older hand by name)
        const sameSeat = (s, w) => !!s && (w.seat ? s.seat === w.seat : s.name === w.name);
        setTimeout(() => {
          for (const w of lr.winners) {
            const k = bySlot.findIndex((s) => sameSeat(s, w));
            if (k >= 0) CZ.pop(els.seats[k], "+" + fmt(w.amount), "win");
          }
          const mineW = me && me.seat ? lr.winners.find((w) => { const s = t.seats.find((x) => sameSeat(x, w)); return s && s.seat === me.seat; }) : null;
          if (mineW) CZ.announce(T("you_won_pot", "You won {n}.", { n: fmt(mineW.amount) }));
        }, delay);
      }
    }

    // message + clock
    let msg = "", sub = "", dl = null, nom = 0;
    if (!open) msg = tn ? (tn.status === "finished" ? T("sng_over", "Finished") : T("sng_off_h", "Called off")) : T("closed", "That table has closed.");
    else if (tn && tn.status === "registering") {
      msg = T("sng_waiting_n", "Waiting for players — {n} of {size}", { n: tn.registered, size: tn.size });
      if (tn.countdown_at) { dl = tn.countdown_at; nom = 60; }
    }
    else if (tn && tn.status === "settling") msg = T("sng_paying", "Paying out…");
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
    const rs = t.rooms && t.rooms.length ? t.rooms.map((r) => r.name) : t.room ? [t.room_name || t.room] : [];       // 1.99ox: every room it plays in
    const where = rs.length ? `🐸 ${esc(rs.length > 1 ? T("in_rooms", "Chat rooms {rooms}", { rooms: rs.join(", ") }) : T("in_room", "Chat room {room}", { room: rs[0] }))}` : `🌐 ${esc(T("web_only", "Web only"))}`;
    const meta = [t.high_stakes ? `💎 ${esc(T("high_roller", "High Roller"))}` : "", `👑 ${esc(t.host)}`, esc(T("blinds_v", "Blinds {sb}/{bb}", { sb: fmt(t.sb), bb: fmt(t.bb) })), where,
                  t.hand_no ? esc(T("hand_n", "Hand #{n}", { n: t.hand_no })) : "",
                  tn ? `🏁 ${esc(T("sng_badge", "Sit & Go"))}` : esc(T("rake_pct", "{n}% rake at showdown", { n: t.rake_pct })),
                  t.on_stream ? `📺 ${esc(T("on_stream", "On Pepe's stream"))}` : t.stream_queue ? `📺 ${esc(T("stream_q", "stream queue #{n}", { n: t.stream_queue }))}` : ""]
      .filter(Boolean).map((x, i) => `<span class="tag${i === 0 && t.high_stakes ? " hr" : ""}">${x}</span>`).join("");
    if ($("cz-meta").dataset.v !== meta) { $("cz-meta").dataset.v = meta; $("cz-meta").innerHTML = meta; }

    const wb = $("cz-watchbar");
    let wtxt = "";
    if (open && !CZ.signed) wtxt = `👁 ${esc(T("watching_hm", "You're watching. Hole cards stay hidden until a showdown."))} <a href="/login">${esc(T("signin_play", "Sign in to play"))}</a>`;
    else if (open && tn && me && !me.seat) {
      wtxt = me.tourney && me.tourney.place ? `🏁 ${esc(T("sng_out_note", "You're out — thanks for playing."))}`
           : tn.status === "registering" ? (me.tourney && me.tourney.registered ? ""     // (review: the invitation only for who may enter)
                                            : me.tourney && me.tourney.can_register ? `🏁 ${esc(T("sng_watch_reg", "Register in the Sit & Go above to play."))}`
                                            : `👁 ${esc(T("sng_watch_run", "You're watching a Sit & Go."))}`)
           : `👁 ${esc(T("sng_watch_run", "You're watching a Sit & Go."))}`;
    }
    else if (open && me && !me.seat && hrLocked) wtxt = `💎 ${esc(T("watching_hr_hm", "A High Roller table: you're watching. Only High Rollers can sit here."))} <a href="/shop">${esc(T("hr_get", "Get the role"))}</a>`;
    else if (open && me && !me.seat) wtxt = `👁 ${esc(t.seats.length >= t.max_seats ? T("watching_full", "You're watching: the table is full.") : T("watching_sit", "You're watching. Take an open seat to play."))}`;
    wb.hidden = !wtxt;
    if (wb.dataset.v !== wtxt) { wb.dataset.v = wtxt; wb.innerHTML = wtxt; }

    dock(t, me, inHand);
    if (me && me.my_turn && !prevTurn) { CZ.announce(T("your_turn_sr_hm", "Your turn. {n} to call.", { n: fmt(t.turn ? t.turn.to_call : 0) })); raiseTouched = false; }
    // 1.99ajw casino2: your turn starts / ends -> the chat's sheet / float makes room for the action dock (casino-chat.js)
    if (!!(me && me.my_turn) !== prevTurn) document.dispatchEvent(new CustomEvent("cz:state", { detail: { myTurn: !!(me && me.my_turn), act: !!(me && me.my_turn) } }));
    prevTurn = !!(me && me.my_turn);
    if (wantSit && me && open && !tn) { wantSit = false; if (!me.seat && t.seats.length < t.max_seats && !hrLocked) openBuy("sit"); }
    first = false;
  }

  // ── h22 (1.99alz): a 🏁 Sit & Go's header and its results card (table.tourney, casino/tourney.js) ──
  function sngHead(t, me) {
    const head = $("cz-snghead"), res = $("cz-sngres");
    if (!head || !res) return;
    const tn = t.tourney || null;
    head.hidden = !tn;
    if (!tn) { res.hidden = true; return; }
    const sub = document.querySelector(".cz-brand small");          // (the top bar's cash-table line: chips = PAT, the rake - not here)
    if (sub) sub.textContent = T("sng_sub", "Sit & Go · tournament chips (not PAT) · no rake");
    const SG = CZ.sng, mt = (me && me.tourney) || {};
    const stat = (label, val) => `<div class="sng-stat"><small>${esc(label)}</small><b>${val}</b></div>`;
    const clock = (dl) => `<span data-sngdl="${Number(dl)}"></span>`;     // (filled by CZ.sng.tick: the header's HTML only changes when its state does)
    const reg = tn.status === "registering", live = tn.status === "running" || tn.status === "settling";
    let html = `<div class="sng-top"><span class="sng-badge">🏁 ${esc(T("sng_badge", "Sit & Go"))}${tn.turbo ? " · " + esc(T("sng_turbo_tag", "Turbo")) : ""}</span>` +
      `<span class="tag gold">${esc(T("sng_entry_n", "Entry {buyin} + {fee}", { buyin: fmt(tn.buyin), fee: fmt(tn.fee) }))}</span>` +
      `<span class="tag">${esc(T("sng_chips_n", "{n} chips", { n: fmt(tn.stack) }))}</span></div>`;
    if (reg) {
      html += '<div class="sng-stats">' + stat(T("sng_registered", "Registered"), `${fmt(tn.registered)}/${fmt(tn.size)}`) +
        stat(T("sng_starts", "Starts"), tn.countdown_at ? clock(tn.countdown_at) : esc(tn.start_at ? T("sng_at_n", "at {n} players", { n: tn.start_at }) : T("sng_when_full_s", "when full"))) +
        stat(T("sng_levels", "Blinds up every"), esc(T("sng_mins_n", "{n} min", { n: tn.level_mins }))) +
        stat(T("sng_pool", "Prize pool"), esc(fmt(tn.pool)) + " PAT") + "</div>" +
        `<p class="sng-who">${esc(tn.entrants.length ? T("sng_entrants", "In: {names}", { names: tn.entrants.map((x) => x.name).join(", ") }) : T("sng_nobody", "Nobody's registered yet."))}</p>`;
    } else if (live) {
      html += '<div class="sng-stats">' + stat(T("sng_level", "Level"), esc(fmt(tn.level))) + stat(T("sng_blinds", "Blinds"), `${fmt(tn.sb)}/${fmt(tn.bb)}`) +
        stat(T("sng_next_level", "Next level"), tn.level_ends_at ? clock(tn.level_ends_at) + ` <small>${esc(T("sng_next_n", "then {sb}/{bb}", { sb: fmt(tn.next_sb), bb: fmt(tn.next_bb) }))}</small>` : "—") +
        stat(T("sng_left", "Players left"), `${fmt(tn.players_left || 0)}/${fmt(tn.field || tn.size)}`) + "</div>";
      const out = tn.places.slice().sort((a, b) => b.place - a.place);
      if (out.length) html += `<p class="sng-who">${esc(T("sng_out_list", "Out: {list}", { list: out.map((p) => "#" + p.place + " " + p.name).join(" · ") }))}</p>`;
    }
    if (reg || live) html += `<div class="sng-prizes"><small>${esc(reg ? T("sng_prizes_full", "Prizes if full") : T("sng_prizes", "Prizes"))}</small>${SG.prizeTags(tn.prizes)}</div>`;
    const acts = [];
    if (reg && CZ.signed && me) {
      if (mt.registered) acts.push(`<button type="button" class="cz-btn ghost sm" data-sng="unregister">${esc(T("sng_unregister", "Unregister"))}</button>`);
      else if (mt.can_register) acts.push(`<button type="button" class="cz-btn gold sm" data-sng="register">${esc(T("sng_register_n", "Register · {n} PAT", { n: fmt(tn.entry) }))}</button>`);
    }
    if ((reg || live) && me && me.admin && tn.status !== "settling") acts.push(`<button type="button" class="cz-btn red sm" data-sng="cancel">${esc(T("sng_cancel", "Cancel (refund everyone)"))}</button>`);
    if (acts.length) html += `<div class="sng-acts">${acts.join("")}</div>`;
    if (head.dataset.v !== html) { head.dataset.v = html; head.innerHTML = html; SG.tick(); }
    let r = "";
    if (tn.status === "finished") {
      r = `<h2>🏆 ${esc(T("sng_results", "Results"))}</h2><ol>` + tn.places.map((p) => `<li${mt.place === p.place ? ' class="me"' : ""}><span>${SG.medal(p.place - 1)} ${esc(p.name)}` +
          `${p.tied ? ` <small>${esc(T("sng_tied", "tied on chips"))}</small>` : ""}</span><b>${p.prize ? esc(fmt(p.prize)) + " PAT" : "—"}</b></li>`).join("") + "</ol>" +
          (mt.place ? `<p>${esc(T("sng_you_place", "You finished in place {n}.", { n: mt.place }))}</p>` : "") +
          `<p class="fine">${esc(T("sng_fee_line", "{n} PAT of entry fees went to the House.", { n: fmt(tn.fee_total) }))}</p>`;
    } else if (tn.status === "cancelled") {
      r = `<h2>🛑 ${esc(T("sng_off_h", "Called off"))}</h2><p>${esc(tn.cancelled === "expired" ? T("sng_expired", "This Sit & Go didn't start in time — every entry was refunded in full.")
                                                                         : T("sng_cancelled", "This Sit & Go was called off — every entry was refunded in full."))}</p>`;
    }
    res.hidden = !r;
    if (res.dataset.v !== r) { res.dataset.v = r; res.innerHTML = r; }
  }

  // ── the chip rack (1.99ov): tap a chip to add it to your bet / raise. Regular chips from half the small blind up; the 💎 ones
  // (100K / 500K / 1M / 5M) only for High Rollers and at High Roller tables. At most six, the ones that fit your stack.
  const RACK = [[25, ""], [100, ""], [500, "c500"], [1000, "c1k"], [5000, "c5k"], [25000, "c25k"]];
  const RACK_HR = [[100000, "c100k hrc"], [500000, "c500k hrc"], [1000000, "c1m hrc"], [5000000, "c5m hrc"]];
  function rackFor(t, me) {
    const hr = !!(t.high_stakes || me.high_roller);
    const { max } = raiseBounds(t);
    let set = (t.high_stakes ? RACK_HR : RACK.concat(hr ? RACK_HR : [])).filter(([v]) => v >= Math.max(1, t.sb / 2) && v <= max);
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
  function preset(p) { const t = last.table; return CZ.sizing.presetTo(p, t.turn, t.bb, t.pot).to; }
  function parsedRaise() { const t = last.table; return CZ.sizing.parseSize($("cz-raise").value, t.turn, t.bb, t.pot); }
  function previewRaise() {
    const p = parsedRaise(), b = $("cz-playbox").querySelector('[data-v="raise"]');
    b.disabled = !!p.error;
    $("cz-raise").setAttribute("aria-invalid", p.error ? "true" : "false");
    if (!p.error) { $("cz-slider").value = p.to; b.textContent = T("raise_to_n", "Raise to {n}", { n: fmt(p.to) }); }
  }
  function setRaise(v) {
    const t = last.table;
    const { min, max } = raiseBounds(t);
    v = Math.max(min, Math.min(max, Math.trunc(Number(v) || min)));
    $("cz-slider").value = String(v);
    $("cz-raise").value = String(v);
    $("cz-playbox").querySelector('[data-v="raise"]').disabled = false;
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
        if (!raiseTouched) setRaise(min);
        previewRaise();
        const potRow = (t.presets_pot || [33,50,75,100,150]).map((n) => [n + "%", n + "%"]);
        const bbRow = t.phase === "preflop" ? (t.presets_bb || [2.5,3,4]).map((n) => [n + "bb", n + "× BB"]) : [];
        let bbFirst = false;
        try { bbFirst = localStorage.getItem("hm_bb_first") === "1"; } catch (e) {}
        const rows = bbFirst ? [bbRow, potRow] : [potRow, bbRow];
        const html = rows.filter((r) => r.length).map((r) => '<span class="hm-preset-row">' + r.map(([p,l]) => `<button type="button" data-p="${esc(p)}">${esc(l)}</button>`).join("") + '</span>').join("") +
          `<button type="button" data-p="min">${esc(T("p_min", "Min"))}</button><button type="button" data-p="all">${esc(T("p_all", "All-in"))}</button>` +
          '<button type="button" data-step="1">+1 BB</button><button type="button" data-step="5">+5 BB</button>' +
          `<button type="button" data-order="1">${esc(T("preset_order", "Swap rows"))}</button>`;
        if ($("cz-presets").dataset.v !== html) { $("cz-presets").dataset.v = html; $("cz-presets").innerHTML = html; }
        rackFor(t, me);
      }
    }
    let wait = "";
    if (me.banned) wait = T("banned", "You're banned from the casino.");
    else if (me.leaving) wait = T("leaving_note", "You'll be cashed out when this hand ends.");
    else if (me.seat && inHand && !myTurn) wait = me.in_hand ? (me.folded ? T("folded_note", "You folded. Next hand soon.") : t.turn ? T("waiting_for", "Waiting for {name}…", { name: t.turn.name }) : "")
                                                              : T("join_next", "You're in from the next hand.");
    else if (me.seat && !inHand && t.tourney) wait = T("sng_chips_note", "Tournament chips (not PAT): {n}", { n: fmt(me.stack) });
    else if (me.seat && !inHand) wait = T("stack_n", "Your stack: {n}", { n: fmt(me.stack) }) + " · " + T("balance_n", "Balance {n}", { n: fmt(me.balance) });
    else if (!me.seat && t.tourney) wait = "";
    else if (!me.seat && t.high_stakes && !me.high_roller) wait = T("hr_watch_note", "💎 High Rollers only: watch the table above.");
    else if (!me.seat) wait = T("buy_note", "Buy in for {min}–{max} chips (chips = PAT).", { min: fmt(t.min_buy), max: fmt(t.max_buy) });
    $("cz-wait").hidden = !wait;
    $("cz-wait").textContent = wait;
    const full = t.seats.length >= t.max_seats;
    $("cz-sit").hidden = !!me.seat || full || me.banned || (!!t.high_stakes && !me.high_roller);
    $("cz-deal").hidden = !(me.seat && !inHand && t.seats.filter((s) => s.stack > 0).length >= 2);
    $("cz-topup").hidden = !(me.seat && !inHand && me.stack + t.min_buy <= t.max_buy);
    $("cz-leave").hidden = !me.seat || me.leaving;
    $("cz-sitout").hidden = !me.seat || me.sitting_out || me.waiting_bb;
    $("cz-sitin").hidden = !me.seat || !me.sitting_out;
    $("cz-postnow").hidden = !me.seat || !(me.sitting_out || me.waiting_bb);
    // (h22: a sit & go deals itself; no PAT in or out; review: and every seat posts its blinds - no "post the big blind now")
    if (t.tourney) for (const id of ["cz-sit", "cz-deal", "cz-topup", "cz-leave", "cz-postnow"]) $(id).hidden = true;
    $("cz-showlabel").hidden = !me.seat;
    $("cz-showhand").checked = !!me.show_hand;
    $("cz-pre").hidden = !(me.in_hand && !me.folded && !myTurn);
    for (const input of $("cz-pre").querySelectorAll("input[data-pre]")) {
      input.checked = !!(me.pre && me.pre.kind === input.dataset.pre);
      input.disabled = input.dataset.pre === "check" && me.to_call > 0;
      if (input.dataset.pre === "call") input.nextElementSibling.textContent = T("call_n", "Call {n}", { n: fmt(me.to_call || 0) });
    }
    for (const id of ["cz-dclock", "cz-fclock"]) $(id).classList.toggle("banking", !!(t.turn && t.turn.banking));
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
      const t = last.table, p = parsedRaise();
      if (p.error) return;
      const amt = p.to;
      if (amt >= t.turn.max_to) return act("allin");
      return act(t.current_bet ? "raise" : "bet", amt);
    });
  }
  $("cz-slider").addEventListener("input", (e) => { raiseTouched = true; setRaise(e.target.value); });
  $("cz-raise").addEventListener("input", () => { raiseTouched = true; previewRaise(); });
  $("cz-rack").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-add]");
    if (!b || !last || !last.table.turn) return;
    const cur = raiseTouched ? Number($("cz-raise").value) || 0 : last.table.turn.current_bet;
    raiseTouched = true;
    setRaise(cur + Number(b.dataset.add));
  });
  $("cz-presets").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || !last || !last.table.turn) return;
    if (b.dataset.order) { try { localStorage.setItem("hm_bb_first", localStorage.getItem("hm_bb_first") === "1" ? "0" : "1"); } catch (err) {} dock(last.table,last.me,true); return; }
    raiseTouched = true;
    setRaise(b.dataset.step ? (parsedRaise().to || last.table.turn.min_to) + Number(b.dataset.step) * last.table.bb : preset(b.dataset.p));
    previewRaise();
  });
  $("cz-pre").addEventListener("change", (e) => { if (e.target.dataset.pre) act("pre", e.target.checked ? e.target.dataset.pre : "off"); });
  $("cz-sitout").addEventListener("click", () => act("sitout"));
  $("cz-sitin").addEventListener("click", () => act("sitin"));
  $("cz-postnow").addEventListener("click", () => act("sitin", "post"));
  $("cz-showhand").addEventListener("change", (e) => act("showhand", e.target.checked ? "1" : "0"));
  let myHands = [], replayStep = 0;
  function drawReplay() {
    const hand = myHands[Number($("cz-handselect").value) || 0];
    if (!hand) { $("cz-replay").textContent = T("no_hands", "No hands played yet."); $("cz-replayprev").disabled = true; $("cz-replaynext").disabled = true; return; }
    const steps = hand.replay || [], step = steps[replayStep], end = !steps.length || replayStep === steps.length-1;
    const board = step ? step.board : hand.board;
    $("cz-replay").innerHTML = `<p><a href="${esc(hand.proof)}">🔐 ${esc(T("verify", "verify"))}</a> · ${esc(T("hand_n", "Hand #{n}", { n: hand.round }))}` +
      (hand.net == null ? "" : ` · ${CZ.net(hand.net)} ${hand.tourney ? esc(T("sng_net_chips", "chips")) : "PAT"}`) + `</p><div>${CZ.staticCards(hand.cards || [])}</div><div>${CZ.staticCards(board || [])}</div>` +
      (step ? `<p>${esc(CZ.streetName(step.street))} · ${replayStep+1}/${steps.length} · ${esc(step.player ? step.player.name : "")} ${esc(step.action)} ${step.amount ? esc(fmt(step.amount)) : ""}</p><p>${esc(T("pot_n", "Pot {n}", {n:fmt(step.pot)}))}</p>` : `<p>${esc(T("old_hand", "Action replay is unavailable for this older hand."))}</p>`) +
      (step ? step.stacks : hand.players || []).map((p)=>`<div class="pl"><b>${esc(p.name)}</b> ${esc(fmt(p.stack))}</div>`).join("") +
      (end ? (hand.pots || []).map((p)=>`<div class="pl">🏆 ${esc(p.name)} +${esc(fmt(p.amount))} · ${esc(potName(p.pot))}</div>`).join("") : "") +
      (end ? (hand.shown || []).map((p)=>`<div class="pl">${esc(p.name)} ${CZ.staticCards(p.cards || [])}</div>`).join("") : "");
    $("cz-replayprev").disabled = replayStep <= 0;
    $("cz-replaynext").disabled = replayStep >= steps.length-1;
  }
  $("cz-myhandsbtn").addEventListener("click", async () => {
    CZ.openSheet("cz-myhands");
    try {
      const j = await (await fetch("/api/casino/me/hands?limit=20", {credentials:"same-origin"})).json();
      if (!j.ok) throw new Error("history");
      myHands = j.hands || []; replayStep = 0;
      $("cz-handselect").innerHTML = myHands.map((h,i)=>`<option value="${i}">${esc(T("hand_n", "Hand #{n}", {n:h.round}))} · ${esc(h.table)}</option>`).join("");
      drawReplay();
    } catch (e) { $("cz-replay").textContent = T("history_fail", "Couldn't load your hands. Try again."); }
  });
  $("cz-handselect").addEventListener("change", () => { replayStep=0; drawReplay(); });
  $("cz-replayprev").addEventListener("click", () => { replayStep=Math.max(0,replayStep-1); drawReplay(); });
  $("cz-replaynext").addEventListener("click", () => { const h=myHands[Number($("cz-handselect").value)||0]; if(h) replayStep=Math.min((h.replay||[]).length-1,replayStep+1); drawReplay(); });
  $("cz-sit").addEventListener("click", () => openBuy("sit"));
  $("cz-topup").addEventListener("click", () => openBuy("top"));
  $("cz-seats").addEventListener("click", (e) => { if (e.target.closest("[data-sit]")) openBuy("sit"); });
  $("cz-buyslider").addEventListener("input", (e) => setBuy(e.target.value));
  $("cz-buyin").addEventListener("change", (e) => setBuy(e.target.value));
  $("cz-buypresets").addEventListener("click", (e) => { const b = e.target.closest("button[data-v]"); if (b) setBuy(b.dataset.v); });
  $("cz-buygo").addEventListener("click", async () => {
    const j = await act("sit", Number($("cz-buyin").value));
    if (j && j.ok) { CZ.closeSheet("cz-buy"); CZ.toast(buyMode === "top" ? T("topped", "Chips added.") : T("seated", "You're seated. Good luck!"), false); }
    // 1.99alq train3 (owner answer 1): the timeout rule, once per player in its first 7 days (casino/notices.js) - translated
    if (j && j.ok && j.notice && j.notice.id === "hm_timeout") CZ.note(T("rule_timeout", j.notice.text, { count: j.notice.mins }));
  });
  $("cz-deal").addEventListener("click", () => act("deal"));
  // h22: the Sit & Go header's Register / Unregister / an admin's Cancel (each with its own idempotency key)
  $("cz-snghead").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-sng]");
    if (!b || b.disabled) return;
    const what = b.dataset.sng;
    if (what === "cancel" && !confirm(T("sng_cancel_q", "Cancel this Sit & Go? Every entry is refunded in full."))) return;
    b.disabled = true;
    const j = await CZ.post(`/api/casino/sng/${encodeURIComponent(CZ.tableId)}/${what}`, { idem: CZ.idem() });
    b.disabled = false;
    CZ.toast(j.reply || j.error || (j.ok ? "" : T("act_fail", "That didn't work.")), !j.ok);
    if (ref.fn) ref.fn();
  });
  $("cz-leave").addEventListener("click", () => act("stand"));
  // keyboard on your turn: F fold, C check / call, R raise (not while typing)
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || /input|select|textarea/i.test((e.target && e.target.tagName) || "")) return;
    if (document.querySelector("dialog[open]") || (e.target && (e.target.isContentEditable || (e.target.closest && e.target.closest('[role="menu"]'))))) return;
    if (e.key === "Enter" && e.target && e.target.closest && e.target.closest('button, a, summary, [role="button"]')) return;
    if (!last || !last.me) return;
    if (e.key === "Escape" && last.me.pre) { e.preventDefault(); act("pre", "off"); return; }
    if (!last.me.my_turn) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); raiseTouched = true; setRaise((parsedRaise().to || last.table.turn.min_to) + (e.key === "ArrowUp" ? 1 : -1) * last.table.bb * (e.shiftKey ? 5 : 1)); previewRaise(); return; }
    if (/^[1-5]$/.test(e.key)) { const p = (last.table.presets_pot || [33,50,75,100,150])[Number(e.key)-1]; if (p) { e.preventDefault(); raiseTouched = true; setRaise(preset(p + "%")); previewRaise(); } return; }
    const k = e.key.toLowerCase();
    const sel = k === "f" ? '[data-v="fold"]' : k === "c" ? '[data-v="check"]:not([hidden]), [data-v="call"]:not([hidden])' : (k === "r" || k === "enter") ? '[data-v="raise"]' : null;
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
