// casinobj.js — the web blackjack table of the casino backend (/casino/blackjack, 1.99lj).
// Polls /api/casino/bj/t/<id> about once a second (the lobby every 4 s) and posts moves to /api/casino/bj/t/<id>/act
// with an idempotency key per click, so a double-click or a retry never moves PAT twice.
(function () {
  "use strict";
  const root = document.getElementById("cb");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const tableId = root.dataset.table || "";
  const signed = !!root.dataset.signed;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString("en-US");
  const SUIT = { s: "♠", h: "♥", d: "♦", c: "♣" };
  const SUITN = { s: "spades", h: "hearts", d: "diamonds", c: "clubs" };
  const RANKN = { A: "Ace", K: "King", Q: "Queen", J: "Jack", T: "10" };
  const card = (c) => `<span class="cd${"hd".includes(c[1]) ? " red" : ""}" role="img" aria-label="${RANKN[c[0]] || c[0]} of ${SUITN[c[1]]}">` +
    `<span class="cr" aria-hidden="true">${c[0] === "T" ? "10" : c[0]}</span><span class="cs" aria-hidden="true">${SUIT[c[1]]}</span></span>`;
  const back = () => '<span class="cd back" role="img" aria-label="face-down card"></span>';
  const idem = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  let skew = 0, last = null, busy = false;

  function status(text, bad) {
    const el = $("cb-status");
    el.textContent = text || "";
    el.className = "status" + (bad ? " bad" : "");
  }

  async function post(url, body) {
    const r = await fetch(url, { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, body: JSON.stringify(body) });
    let j = {};
    try { j = await r.json(); } catch (e) { j = {}; }
    return j;
  }

  // ── lobby ──
  async function lobby() {
    $("cb-lobby").hidden = false;
    try {
      const j = await (await fetch("/api/casino/bj/lobby", { credentials: "same-origin" })).json();
      const list = j.tables || [];
      $("cb-tables").innerHTML = list.length ? list.map((t) => `<div class="trow"><span><b>${esc(t.host)}'s table</b> · ${t.players}/${t.max_seats} seated · ` +
        `${fmt(t.min_bet)}–${fmt(t.max_bet)} PAT${t.room ? " · also in Camfrog room <b>" + esc(t.room_name) + "</b>" : " · web only"}</span>` +
        `<a href="/casino/blackjack/t/${esc(t.id)}">Sit down →</a></div>`).join("") : '<p class="info">No table is open. Open one and others can join you.</p>';
      $("cb-open-box").hidden = !signed || !j.enabled;
      if (!j.enabled) status("Blackjack on the site is switched off right now.", true);
    } catch (e) { status("Couldn't load the tables.", true); }
  }
  $("cb-open").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    const j = await post("/api/casino/bj/open", { idem: idem() });
    busy = false;
    if (j.ok && j.table) location.href = "/casino/blackjack/t/" + j.table;
    else status(j.reply || j.error || "Couldn't open a table.", true);
  });

  // ── a table ──
  function render(d) {
    const t = d.table, me = d.me;
    last = d;
    skew = Date.now() - d.now;
    $("cb-where").textContent = (t.room ? "In Camfrog room " + (t.room_name || t.room) + " and on the web" : "Web table") + " · host " + t.host;
    $("cb-round").textContent = t.round_no ? "Round " + t.round_no : "";
    const dl = t.dealer;
    $("cb-dealer").innerHTML = (dl.cards || []).map(card).join("") + (dl.hidden ? back() : "");
    $("cb-dval").textContent = dl.cards && dl.cards.length ? (dl.hidden ? "shows " + dl.value : dl.value + (dl.bust ? " BUST" : dl.blackjack ? " BLACKJACK" : "")) : "";
    let msg = "";
    if (t.status === "closed") msg = "This table has closed.";
    else if (t.phase === "betting") msg = "Place your bets!";
    else if (t.phase === "insurance") msg = "Pepe shows an Ace — insurance?";
    else if (t.turn) msg = t.turn.name + " to act" + (t.turn.num_hands > 1 ? ` (hand ${t.turn.hand_index + 1}/${t.turn.num_hands})` : "");
    $("cb-msg").textContent = msg;
    const deadline = t.phase === "betting" ? t.bet_deadline : t.phase === "insurance" ? t.ins_deadline : t.turn ? t.turn.deadline : null;
    const total = t.phase === "betting" ? 30 : t.phase === "insurance" ? 18 : t.act_secs;
    $("cb-clock").innerHTML = deadline ? `<div class="tbar" data-dl="${deadline}" data-total="${total * 1000}"><i></i></div>` : "";
    $("cb-seats").innerHTML = (t.seats || []).map((s) => {
      const mine = me && me.seat && s.seat === me.seat;
      const tags = [s.host ? '<span class="tag gold">host</span>' : "", s.via === "room" ? '<span class="tag blue">camfrog</span>' : "",
                    s.autobet ? '<span class="tag">auto</span>' : "", s.insured ? '<span class="tag green">insured</span>' : "",
                    s.leaving ? '<span class="tag red">leaving</span>' : "", s.pending ? `<span class="tag">next ${fmt(s.pending)}</span>` : ""].join("");
      const hands = (s.hands || []).map((h) => `<div class="hand${h.current ? " cur" : ""}"><div class="cards">${h.cards.map(card).join("")}</div>` +
        `<div class="v">${h.value}${h.soft ? " soft" : ""} · ${fmt(h.bet)}${h.doubled ? " ×2" : ""}${h.outcome ? " · " + h.outcome.toUpperCase() : ""}</div></div>`).join("");
      return `<div class="seat${mine ? " me" : ""}${s.turn ? " turn" : ""}"><div class="nm">${esc(s.name)}</div>` +
        `<div class="st">${s.bet ? "bet " + fmt(s.bet) : "no bet"}</div><div>${tags}</div>${hands}</div>`;
    }).join("") || '<p class="info" style="color:#fff">Nobody is seated yet — bet to sit down.</p>';
    const lr = t.last_round;
    $("cb-lastround").innerHTML = lr ? `<div class="last">Last round (${lr.round_no}): Pepe ${lr.dealer.value}${lr.dealer.bust ? " BUST" : lr.dealer.blackjack ? " BJ" : ""} — ` +
      lr.players.map((p) => `${esc(p.name)} ${p.net > 0 ? "+" + fmt(p.net) : p.net < 0 ? fmt(p.net) : "±0"}`).join(" · ") +
      ` · <a href="/casino/fair/${esc(t.id)}/${lr.round_no}">verify</a></div>` : "";
    $("cb-log").innerHTML = (t.log || []).slice().reverse().map((l) => `<div>${esc(l.text)}</div>`).join("");
    $("cb-fair").innerHTML = t.commitment ? `Round ${t.commit_round} commitment: <code>${esc(t.commitment)}</code><br>Client seed: <code>${esc(t.client_seed)}</code>` : "";

    // controls
    const open = t.status === "open";
    $("cb-signin").hidden = signed;
    $("cb-ctl").hidden = !signed || !open;
    if (!me || !open) return;
    const betting = t.phase === "betting" || t.phase === "idle";
    $("cb-betrow").hidden = false;
    $("cb-bet").textContent = betting ? "Bet" : "Bet next round";
    $("cb-bet").disabled = betting && me.bet > 0;
    $("cb-auto").textContent = me.autobet ? "Autobet off" : "Autobet";
    $("cb-deal").hidden = !betting;
    const amt = $("cb-amt");
    if (!amt.dataset.touched && me.lastbet) amt.value = me.lastbet;
    const turn = me.my_turn && t.turn;
    $("cb-playrow").hidden = !(turn || me.can_insure);
    for (const b of document.querySelectorAll("#cb-playrow button")) {
      const v = b.dataset.v;
      b.hidden = v === "insurance" ? !me.can_insure : !turn;
      if (v === "double") b.disabled = !(turn && t.turn.can_double);
      if (v === "split") b.disabled = !(turn && t.turn.can_split);
    }
    $("cb-mine").textContent = `Balance ${fmt(me.balance)} PAT` + (me.high_roller ? " · High Roller (no max)" : "") + (me.banned ? " · banned from the casino" : "");
    $("cb-leave").hidden = !me.seat && !me.pending;
    $("cb-end").hidden = !(me.host || me.admin);
    const rooms = d.rooms || [];
    $("cb-pushrow").hidden = !(me.host || me.admin) || (!rooms.length && !t.room);
    const sel = $("cb-room");
    const want = rooms.map((r) => r.id + "|" + r.name).join(",");
    if (sel.dataset.v !== want) {
      sel.dataset.v = want;
      sel.innerHTML = rooms.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}${r.busy && r.id !== t.room ? " (has a table)" : ""}</option>`).join("");
    }
    $("cb-push").hidden = !rooms.length;
    $("cb-unpush").hidden = !t.room;
  }

  async function act(verb, amount) {
    if (busy) return;
    busy = true;
    try {
      const j = await post(`/api/casino/bj/t/${tableId}/act`, { verb, amount, idem: idem() });
      status(j.reply || (j.ok ? "" : j.error || "That didn't work."), !j.ok);
    } catch (e) {
      status("Couldn't reach the table — try again.", true);
    } finally {
      busy = false;
      refresh();
    }
  }

  async function refresh() {
    try {
      const r = await fetch(`/api/casino/bj/t/${tableId}`, { credentials: "same-origin" });
      if (r.status === 404) { status("That table has closed.", true); $("cb-ctl").hidden = true; return; }
      render(await r.json());
    } catch (e) { /* next tick */ }
  }

  function clocks() {
    for (const bar of document.querySelectorAll(".tbar")) {
      const left = Number(bar.dataset.dl) - (Date.now() - skew);
      const pct = Math.max(0, Math.min(100, (left / Number(bar.dataset.total)) * 100));
      bar.firstChild.style.width = pct + "%";
    }
  }

  if (!tableId) {
    lobby();
    setInterval(lobby, 4000);
    return;
  }
  $("cb-table").hidden = false;
  $("cb-amt").addEventListener("input", (e) => { e.target.dataset.touched = "1"; });
  $("cb-bet").addEventListener("click", () => act("bet", $("cb-amt").value));
  $("cb-auto").addEventListener("click", () => act("autobet", last && last.me && last.me.autobet ? "off" : $("cb-amt").value));
  $("cb-deal").addEventListener("click", () => act("deal"));
  $("cb-leave").addEventListener("click", () => act("leave"));
  $("cb-end").addEventListener("click", () => { if (confirm("Close this table?")) act("end"); });
  for (const b of document.querySelectorAll("#cb-playrow button")) b.addEventListener("click", () => act(b.dataset.v));
  $("cb-push").addEventListener("click", async () => {
    const j = await post(`/api/casino/bj/t/${tableId}/push`, { room: $("cb-room").value });
    status(j.reply || j.error || "", !j.ok);
    refresh();
  });
  $("cb-unpush").addEventListener("click", async () => {
    const j = await post(`/api/casino/bj/t/${tableId}/push`, { room: null });
    status(j.reply || j.error || "", !j.ok);
    refresh();
  });
  refresh();
  setInterval(refresh, 1000);
  setInterval(clocks, 250);
})();
