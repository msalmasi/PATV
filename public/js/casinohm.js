// casinohm.js — the web Hold'em table of the casino backend (/casino/holdem, 1.99lv). A functional page (the design pass
// comes after hold'em lands, the user's D10). Polls /api/casino/t/<id> about once a second; your own hole cards come only
// in your own `me` part. Every move posts with an idempotency key, so a double-click or a retry never moves PAT twice.
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

  function status(text, bad) { const el = $("cb-status"); el.textContent = text || ""; el.className = "status" + (bad ? " bad" : ""); }
  async function post(url, body) {
    const r = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
                                 body: JSON.stringify(body) });
    try { return await r.json(); } catch (e) { return {}; }
  }

  async function lobby() {
    $("cb-lobby").hidden = false;
    try {
      const j = await (await fetch("/api/casino/lobby", { credentials: "same-origin" })).json();
      const list = (j.tables || []).filter((t) => t.game === "holdem");
      $("cb-tables").innerHTML = list.length ? list.map((t) => `<div class="trow"><span><b>${esc(t.host)}'s table</b> · ${fmt(t.sb)}/${fmt(t.bb)} · ` +
        `${t.players}/${t.max_seats} seated${t.high_stakes ? " · 💎" : ""}${t.room ? " · also in Camfrog room <b>" + esc(t.room_name) + "</b>" : " · web only"}` +
        `${t.on_stream ? " · 📺 on stream" : ""}</span><a href="/casino/holdem/t/${esc(t.id)}">Sit down →</a></div>`).join("")
        : '<p class="info">No Hold\'em table is open. Open one and others can join you.</p>';
      $("cb-open-box").hidden = !signed || !j.hm_enabled;
      if (!j.hm_enabled) status("Hold'em on the site is switched off right now.", true);
    } catch (e) { status("Couldn't load the tables.", true); }
  }
  $("cb-open").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    const j = await post("/api/casino/open", { game: "holdem", blinds: $("cb-blinds").value, idem: idem() });
    busy = false;
    if (j.ok && j.table) location.href = "/casino/holdem/t/" + j.table;
    else status(j.reply || j.error || "Couldn't open a table.", true);
  });

  function render(d) {
    const t = d.table, me = d.me;
    last = d;
    skew = Date.now() - d.now;
    $("cb-where").textContent = (t.room ? "In Camfrog room " + (t.room_name || t.room) + " and on the web" : "Web table") + " · host " + t.host +
      ` · blinds ${fmt(t.sb)}/${fmt(t.bb)}` + (t.on_stream ? " · 📺 on Pepe's stream" : t.stream_queue ? ` · stream queue #${t.stream_queue}` : "");
    $("cb-round").textContent = t.hand_no ? "Hand #" + t.hand_no : "";
    $("cb-board").innerHTML = (t.board || []).map(card).join("");
    $("cb-pot").textContent = t.pot ? "Pot " + fmt(t.pot) + ((t.pots || []).length > 1 ? " (" + t.pots.map((p) => fmt(p.amount)).join(" + ") + ")" : "") : "";
    let msg = "";
    if (t.status === "closed") msg = "This table has closed.";
    else if (t.turn) msg = `${t.turn.name} to act` + (t.turn.to_call ? ` — ${fmt(t.turn.to_call)} to call` : "");
    else if (t.phase === "between") msg = t.next_at ? "Next hand soon" : "Waiting for players — 2+ seated, then Deal";
    $("cb-msg").textContent = msg;
    const deadline = t.turn ? t.turn.deadline : t.next_at;
    const total = t.turn ? t.act_secs : 15;
    $("cb-clock").innerHTML = deadline ? `<div class="tbar" data-dl="${deadline}" data-total="${total * 1000}"><i></i></div>` : "";
    $("cb-seats").innerHTML = (t.seats || []).map((s) => {
      const mine = me && me.seat && s.seat === me.seat;
      const tags = [s.button ? '<span class="tag d">D</span>' : "", s.blind ? `<span class="tag">${s.blind}</span>` : "", s.host ? '<span class="tag gold">host</span>' : "",
                    s.via === "room" ? '<span class="tag blue">camfrog</span>' : "", s.status === "allin" ? '<span class="tag red">all-in</span>' : "",
                    s.leaving ? '<span class="tag red">leaving</span>' : ""].join("");
      const cards = s.shown ? s.shown.map(card).join("") : s.cards_down ? back() + back() : "";
      return `<div class="seat${mine ? " me" : ""}${s.turn ? " turn" : ""}${s.status === "folded" ? " folded" : ""}${s.winner ? " winner" : ""}">` +
        `<div class="nm">${esc(s.name)}</div><div class="st">${fmt(s.stack)}${s.bet ? " · bet " + fmt(s.bet) : ""}</div><div>${tags}</div>` +
        `<div class="cards">${cards}</div>${s.hand ? `<div class="info">${esc(s.hand)}</div>` : ""}</div>`;
    }).join("") || '<p class="info" style="color:#fff">Nobody is seated yet.</p>';
    $("cb-mine-cards").innerHTML = me && me.cards ? `<div class="info" style="color:#fff">Your cards${me.folded ? " (folded)" : ""}</div><div class="cards">${me.cards.map(card).join("")}</div>` : "";
    const lr = t.last_round;
    $("cb-lastround").innerHTML = lr ? `<div class="last">Hand #${lr.hand_no}: ` + lr.winners.map((w) => `${esc(w.name)} +${fmt(w.amount)} (${esc(w.hand)})`).join(" · ") +
      (lr.rake ? ` · rake ${fmt(lr.rake)}` : "") + ` · <a href="/casino/fair/${esc(t.id)}/${lr.hand_no}">verify</a></div>` : "";
    $("cb-log").innerHTML = (t.log || []).slice().reverse().map((l) => `<div>${esc(l.text)}</div>`).join("");
    $("cb-fair").innerHTML = t.commitment ? `Hand ${t.commit_round} commitment: <code>${esc(t.commitment)}</code><br>Client seed: <code>${esc(t.client_seed)}</code>` : "";

    const open = t.status === "open";
    $("cb-signin").hidden = signed;
    $("cb-ctl").hidden = !signed || !open;
    if (!me || !open) return;
    const amt = $("cb-amt");
    if (!amt.dataset.touched) amt.value = t.min_buy;
    $("cb-sit").textContent = me.seat ? "Top up" : "Buy in";
    $("cb-deal").hidden = t.phase !== "between";
    const turn = me.my_turn && t.turn;
    $("cb-playrow").hidden = !turn;
    if (turn) {
      document.querySelector('[data-v="check"]').hidden = !t.turn.can_check;
      const call = document.querySelector('[data-v="call"]');
      call.hidden = t.turn.can_check;
      call.textContent = "Call " + fmt(t.turn.to_call);
      const r = $("cb-raise");
      if (!r.dataset.touched || Number(r.value) < t.turn.min_to) r.value = Math.min(t.turn.min_to, t.turn.max_to);
      document.querySelector('[data-v="raise"]').textContent = t.current_bet ? "Raise to" : "Bet";
      document.querySelector('[data-v="raise"]').disabled = !t.turn.can_raise;
    }
    $("cb-mine").textContent = `Balance ${fmt(me.balance)} PAT` + (me.seat ? ` · stack ${fmt(me.stack)}` : "") + (me.high_roller ? " · High Roller" : "") + (me.banned ? " · banned from the casino" : "");
    $("cb-leave").hidden = !me.seat;
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
    $("cb-stream").hidden = !t.room || t.on_stream;
    $("cb-unstream").hidden = !(t.on_stream || t.stream_queue);
  }

  async function act(verb, amount) {
    if (busy) return;
    busy = true;
    try {
      const j = await post(`/api/casino/t/${tableId}/act`, { verb, amount, idem: idem() });
      status(j.reply || (j.ok ? "" : j.error || "That didn't work."), !j.ok);
    } catch (e) { status("Couldn't reach the table — try again.", true); }
    finally { busy = false; refresh(); }
  }
  async function refresh() {
    try {
      const r = await fetch(`/api/casino/t/${tableId}`, { credentials: "same-origin" });
      if (r.status === 404) { status("That table has closed.", true); $("cb-ctl").hidden = true; return; }
      render(await r.json());
    } catch (e) { /* next tick */ }
  }
  function clocks() {
    for (const bar of document.querySelectorAll(".tbar")) {
      const left = Number(bar.dataset.dl) - (Date.now() - skew);
      bar.firstChild.style.width = Math.max(0, Math.min(100, (left / Number(bar.dataset.total)) * 100)) + "%";
    }
  }

  if (!tableId) { lobby(); setInterval(lobby, 4000); return; }
  $("cb-table").hidden = false;
  $("cb-amt").addEventListener("input", (e) => { e.target.dataset.touched = "1"; });
  $("cb-raise").addEventListener("input", (e) => { e.target.dataset.touched = "1"; });
  $("cb-sit").addEventListener("click", () => act("sit", $("cb-amt").value));
  $("cb-deal").addEventListener("click", () => act("deal"));
  $("cb-leave").addEventListener("click", () => act("stand"));
  $("cb-end").addEventListener("click", () => { if (confirm("Close this table? Everyone is cashed out.")) act("end"); });
  for (const b of document.querySelectorAll("#cb-playrow button")) {
    b.addEventListener("click", () => {
      const v = b.dataset.v;
      if (v === "raise") act(last && last.table.current_bet ? "raise" : "bet", $("cb-raise").value);
      else act(v);
    });
  }
  const side = async (url, body) => { const j = await post(url, body); status(j.reply || j.error || "", !j.ok); refresh(); };
  $("cb-push").addEventListener("click", () => side(`/api/casino/t/${tableId}/push`, { room: $("cb-room").value }));
  $("cb-unpush").addEventListener("click", () => side(`/api/casino/t/${tableId}/push`, { room: null }));
  $("cb-stream").addEventListener("click", () => side(`/api/casino/t/${tableId}/stream`, { on: true, override: !!(last && last.me && last.me.admin && confirm("Admin: take the stream now (the current table goes next in line)? Cancel = join the queue.")) }));
  $("cb-unstream").addEventListener("click", () => side(`/api/casino/t/${tableId}/stream`, { on: false }));
  refresh();
  setInterval(refresh, 1000);
  setInterval(clocks, 250);
})();
