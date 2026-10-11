// casino-ui.js — the casino tables' shared front end (D10 design pass, 2026-10-11): helpers for cards (deal / flip
// animations by diffing what's on the felt), chips, avatars, countdown rings tied to the server's deadlines, the toast /
// aria-live announcer, sheets (history, host tools), and the casino LOBBY (both games). casinobj.js and casinohm.js
// draw their own tables on top of it. Strings: __t("js.casino.*", English default) - the defaults equal locales/en.json.
(function () {
  "use strict";
  const root = document.getElementById("cb");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const T = (k, d, v) => (window.__t ? window.__t("js.casino." + k, d, v) : String(d).replace(/\{!?(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : m)));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lang = document.documentElement.lang || "en";
  const fmt = (n) => { try { return Math.trunc(Number(n) || 0).toLocaleString(lang); } catch (e) { return String(Math.trunc(Number(n) || 0)); } };
  const reduced = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const idem = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const game = root.dataset.game === "holdem" ? "holdem" : "bj";
  const tableId = root.dataset.table || "";
  const signed = !!root.dataset.signed;

  async function post(url, body) {
    const r = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
                                 body: JSON.stringify(body) });
    try { return await r.json(); } catch (e) { return { ok: false }; }
  }

  // ── toast (replies / errors) and a polite announcer used sparingly (your turn, results) ──
  let toastTm = null;
  function toast(text, bad) {
    const el = $("cz-toast");
    if (!el) return;
    el.textContent = text || "";
    el.className = "cz-toast" + (bad ? " bad" : "");
    clearTimeout(toastTm);
    if (text) toastTm = setTimeout(() => { el.textContent = ""; }, bad ? 7000 : 4000);
  }
  let lastSaid = "";
  function announce(text) {
    const el = $("cz-live");
    if (!el || !text || text === lastSaid) return;
    lastSaid = text;
    el.textContent = text;
  }

  // ── cards ──
  const SUIT = { s: "♠", h: "♥", d: "♦", c: "♣" };
  const suitName = (s) => ({ s: T("suit_s", "spades"), h: T("suit_h", "hearts"), d: T("suit_d", "diamonds"), c: T("suit_c", "clubs") }[s] || s);
  const rankName = (r) => ({ A: T("rank_a", "Ace"), K: T("rank_k", "King"), Q: T("rank_q", "Queen"), J: T("rank_j", "Jack"), T: "10" }[r] || r);
  const cardLabel = (c) => T("card_of", "{rank} of {suit}", { rank: rankName(c[0]), suit: suitName(c[1]) });
  const faceHTML = (c) => `<span class="r">${c[0] === "T" ? "10" : esc(c[0])}</span><span class="s1">${SUIT[c[1]] || ""}</span><span class="s2">${SUIT[c[1]] || ""}</span>`;
  const DOWN = "??";
  function cardEl(c) {
    const el = document.createElement("span");
    el.className = "pc";
    el.setAttribute("role", "img");
    el.innerHTML = '<span class="pc-in" aria-hidden="true"><span class="pc-f"></span><span class="pc-b"></span></span>';
    setFace(el, c);
    return el;
  }
  function setFace(el, c) {
    const f = el.querySelector(".pc-f");
    if (!c || c === DOWN) {
      el.classList.add("down");
      el.classList.remove("red");
      f.innerHTML = "";
      el.setAttribute("aria-label", T("card_down", "face-down card"));
      el.dataset.c = DOWN;
      return;
    }
    f.innerHTML = faceHTML(c);
    el.classList.toggle("red", "hd".includes(c[1]));
    el.setAttribute("aria-label", cardLabel(c));
    el.dataset.c = c;
  }
  /** Draw `cards` (codes, or "??" face down) into `box`, animating only what changed: new cards are dealt in (staggered),
   *  a face-down card that becomes known flips over. opts: {deal, flip, delay0, step, fx, fy} */
  function drawCards(box, cards, opts) {
    opts = opts || {};
    const list = (cards || []).map((c) => c || DOWN);
    const sig = list.join(",");
    if (box.dataset.sig === sig) return 0;
    const old = box.dataset.sig ? box.dataset.sig.split(",") : [];
    const prefix = old.length <= list.length && old.every((c, i) => c === list[i] || c === DOWN);
    box.dataset.sig = sig;
    let added = 0;
    const step = opts.step == null ? 0.14 : opts.step;
    const delay0 = opts.delay0 || 0;
    if (!prefix) { box.textContent = ""; }
    const start = prefix ? old.length : 0;
    if (prefix) {
      for (let i = 0; i < old.length; i++) {
        if (old[i] === DOWN && list[i] !== DOWN) {
          const el = box.children[i];
          if (!el) continue;
          setFace(el, list[i]);
          el.classList.add("down");                                 // the face is in; turn it over
          const go = () => el.classList.remove("down");
          if (reduced) go(); else setTimeout(go, 30 + (opts.flipDelay || 0));
        }
      }
    }
    const animate = opts.deal !== false && !reduced && (prefix || opts.dealAll);
    for (let i = start; i < list.length; i++) {
      const c = list[i];
      const el = cardEl(opts.flip && animate && c !== DOWN ? DOWN : c);
      if (animate) {
        const dl = delay0 + added * step;
        el.classList.add("deal");
        el.style.setProperty("--dl", dl + "s");
        if (opts.fx) el.style.setProperty("--fx", opts.fx);
        if (opts.fy) el.style.setProperty("--fy", opts.fy);
        if (opts.flip && c !== DOWN) setTimeout(() => setFace(el, c) || el.classList.remove("down"), (dl + 0.3) * 1000);
        el.addEventListener("animationend", () => el.classList.remove("deal"), { once: true });
      }
      box.appendChild(el);
      added += 1;
    }
    return added;
  }
  const staticCards = (cards, cls) => `<span class="cards row${cls ? " " + cls : ""}">` + (cards || []).map((c) =>
    `<span class="pc${"hd".includes(c[1]) ? " red" : ""}" role="img" aria-label="${esc(cardLabel(c))}"><span class="pc-in" aria-hidden="true"><span class="pc-f">${faceHTML(c)}</span>` +
    '<span class="pc-b"></span></span></span>').join("") + "</span>";

  // ── chips / avatars ──
  // 1.99ov: the 💎 High Roller denominations (100K / 500K / 1M / 5M) are only drawn for High Rollers and at High Roller tables
  // (hr = true); everyone else sees the regular chips (the 25K black chip on top).
  const DENOMS = [[25000, "c25k"], [5000, "c5k"], [1000, "c1k"], [500, "c500"], [100, ""], [1, ""]];
  const HR_DENOMS = [[5000000, "c5m hrc"], [1000000, "c1m hrc"], [500000, "c500k hrc"], [100000, "c100k hrc"]];
  const denoms = (hr) => (hr ? HR_DENOMS.concat(DENOMS) : DENOMS);
  const chipCls = (n, hr) => { for (const [v, c] of denoms(hr)) if (n >= v) return c; return ""; };
  /** a few chips of n, stacked (biggest on top): the greedy breakdown in the denominations this viewer sees, at most 5 */
  function pileHTML(n, hr) {
    const out = [];
    let left = Math.max(0, Math.trunc(Number(n) || 0));
    for (const [v, c] of denoms(hr)) {
      while (left >= v && out.length < 5) { out.push(c); left -= v; }
      if (out.length >= 5) break;
    }
    if (!out.length) out.push("");
    out.reverse();                                   // the smallest at the bottom, the biggest on top
    return `<span class="pile" style="--n:${out.length}" aria-hidden="true">` + out.map((c, i) => `<span class="chip ${c}" style="--i:${i}"></span>`).join("") + "</span>";
  }
  const stackHTML = (n, label, hr) => `<span class="stack${hr && n >= 100000 ? " hr" : ""}"${label ? ` aria-label="${esc(label)}"` : ""}>${pileHTML(n, hr)}${fmt(n)}</span>`;
  /** the chip labels: 500, 1K, 25K, 1M, 2.5M */
  const short = (n) => (n >= 1e6 ? +(n / 1e6).toFixed(1) + "M" : n >= 1e3 ? +(n / 1e3).toFixed(1) + "K" : String(n));
  function avatarHTML(s, badge) {
    const init = esc((String(s.name || "?").trim()[0] || "?"));
    const img = s.avatar ? `<img src="${esc(s.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
    return `<span class="av" aria-hidden="true">${init}${img ? img : ""}${badge ? `<span class="badge">${badge}</span>` : ""}</span>`;
  }

  // ── countdown rings: every deadline is an absolute server time; skew = local clock - server clock ──
  let skew = 0;
  const totals = new Map();          // deadline -> its full length (ms), so a ring opened mid-countdown starts at the right point
  const ringSVG = () => '<svg class="ring" viewBox="0 0 52 52" aria-hidden="true" focusable="false"><circle class="bg" cx="26" cy="26" r="23"/>' +
                        '<circle class="fg" cx="26" cy="26" r="23" pathLength="100" stroke-dasharray="100" stroke-dashoffset="0"/></svg>';
  function setSkew(serverNow) { if (serverNow) skew = Date.now() - Number(serverNow); }
  function totalFor(dl, nominalSecs) {
    if (!dl) return 0;
    if (!totals.has(dl)) {
      const left = dl - (Date.now() - skew);
      const nom = (nominalSecs || 0) * 1000;
      totals.set(dl, nom && left <= nom + 1500 ? nom : Math.max(left, 1000));
      if (totals.size > 200) totals.delete(totals.keys().next().value);
    }
    return totals.get(dl);
  }
  /** mark an element as a countdown: it gets a ring (if it hasn't one) and data-dl / data-total */
  function armClock(el, dl, nominalSecs) {
    if (!el) return;
    if (!dl) { el.hidden = el.classList.contains("clock") ? true : el.hidden; delete el.dataset.dl; const r = el.querySelector(":scope > .ring"); if (r) r.remove(); return; }
    if (el.classList.contains("clock")) el.hidden = false;
    if (!el.querySelector(":scope > .ring")) el.insertAdjacentHTML("afterbegin", ringSVG());
    el.dataset.dl = dl;
    el.dataset.total = totalFor(dl, nominalSecs);
  }
  function tickClocks() {
    const now = Date.now() - skew;
    for (const el of document.querySelectorAll("[data-dl]")) {
      const left = Math.max(0, Number(el.dataset.dl) - now);
      const frac = Math.max(0, Math.min(1, left / (Number(el.dataset.total) || 1)));
      const ring = el.querySelector(":scope > .ring");
      if (ring) {
        ring.querySelector(".fg").style.strokeDashoffset = String(100 * (1 - frac));
        ring.classList.toggle("low", frac < 0.25);
      }
      const num = el.querySelector(":scope > .secs");
      if (num) num.textContent = String(Math.ceil(left / 1000));
    }
  }
  setInterval(tickClocks, 250);

  // ── pops (+1,000 over a seat) ──
  function pop(seatEl, text, kind) {
    if (!seatEl) return;
    const p = document.createElement("span");
    p.className = "pop " + (kind || "win");
    p.textContent = text;
    p.setAttribute("aria-hidden", "true");
    seatEl.appendChild(p);
    setTimeout(() => p.remove(), 2500);
  }
  const net = (n) => (n > 0 ? `<span class="net-p">+${fmt(n)}</span>` : n < 0 ? `<span class="net-n">−${fmt(-n)}</span>` : '<span class="net-0">±0</span>');

  // ── sheets ──
  function openSheet(id) {
    const d = $(id);
    if (!d) return;
    if (typeof d.showModal === "function") { if (!d.open) d.showModal(); } else d.setAttribute("open", "");
  }
  function closeSheet(id) { const d = $(id); if (d && d.open) { if (typeof d.close === "function") d.close(); else d.removeAttribute("open"); } }
  for (const d of document.querySelectorAll("dialog.sheet")) {
    d.addEventListener("click", (e) => { if (e.target === d) closeSheet(d.id); });               // a tap on the backdrop closes it
    for (const x of d.querySelectorAll("[data-close]")) x.addEventListener("click", () => closeSheet(d.id));
  }

  // ── hand history (casino_rounds, revealed rounds only; the game formats each row) ──
  async function loadHistory(fmtRow) {
    const box = $("cz-hist");
    box.innerHTML = `<p class="fine">${esc(T("loading", "Loading…"))}</p>`;
    try {
      const j = await (await fetch(`/api/casino/t/${tableId}/history?limit=20`, { credentials: "same-origin" })).json();
      const rows = (j.rounds || []).filter((r) => r.results);
      box.innerHTML = rows.length ? rows.map((r) => `<div class="hrow">${fmtRow(r)}</div>`).join("")
                                  : `<p class="fine">${esc(T("hist_none", "No finished rounds yet."))}</p>`;
    } catch (e) {
      box.innerHTML = `<p class="fine">${esc(T("hist_fail", "Couldn't load the history."))}</p>`;
    }
  }

  // ── host tools: push to a Camfrog room, Pepe's stream (FIFO queue, admin override) ──
  let hostState = null;
  function hostTools(d) {
    const t = d.table, me = d.me;
    hostState = d;
    const can = !!(me && (me.host || me.admin) && t.status === "open");
    const btn = $("cz-hostbtn");
    if (btn) btn.hidden = !can;
    if (!can) return;
    // 1.99ox: a table can play in several Camfrog rooms at once - the attached ones (✕ detaches), and the rest to add
    const attached = t.rooms || (t.room ? [{ id: t.room, name: t.room_name || t.room }] : []);
    const ids = new Set(attached.map((r) => r.id));
    const rooms = (d.rooms || []).filter((r) => !ids.has(r.id));
    const sel = $("cz-room");
    const want = rooms.map((r) => r.id + "|" + r.name + "|" + (r.busy ? 1 : 0)).join(",");
    if (sel.dataset.v !== want) {
      sel.dataset.v = want;
      sel.innerHTML = rooms.map((r) => `<option value="${esc(r.id)}"${r.busy ? " disabled" : ""}>${esc(r.name)}${r.busy ? " · " + esc(T("room_busy", "has a table")) : ""}</option>`).join("");
    }
    const list = $("cz-roomlist");
    const lsig = attached.map((r) => r.id + "|" + r.name).join(",");
    if (list && list.dataset.v !== lsig) {
      list.dataset.v = lsig;
      list.innerHTML = attached.map((r) => `<span>🐸 ${esc(r.name)}<button type="button" data-unroom="${esc(r.id)}" aria-label="${esc(T("room_remove", "Remove {room}", { room: r.name }))}">×</button></span>`).join("");
    }
    $("cz-roomnone").hidden = rooms.length > 0 || attached.length > 0;
    $("cz-room").hidden = !rooms.length;
    $("cz-push").hidden = !rooms.length;
    $("cz-unpush").hidden = !attached.length;
    $("cz-roomnow").textContent = attached.length > 1 ? T("rooms_now", "Playing in {n} Camfrog rooms and on the web.", { n: attached.length })
                                : t.room ? T("room_now", "Now in Camfrog room {room} and on the web.", { room: t.room_name || t.room })
                                : T("room_web", "Web only right now.");
    let s;
    if (t.on_stream) s = T("stream_on", "📺 This table is on Pepe's stream.");
    else if (t.stream_queue) s = t.stream_queue === 1 ? T("stream_next", "You're next in line for Pepe's stream.")
                                                      : T("stream_queued", "You're number {n} in line for Pepe's stream.", { n: t.stream_queue });
    else if (!t.room) s = T("stream_needroom", "Push the table to a Camfrog room first: the stream shows Pepe's rooms.");
    else s = T("stream_free", "Ask for Pepe's stream: first come, first served, then a queue.");
    $("cz-streamnow").textContent = s;
    $("cz-stream").hidden = !t.room || t.on_stream;
    $("cz-stream").textContent = t.stream_queue ? T("stream_waiting", "In the queue") : T("stream_ask", "Put it on Pepe's stream");
    $("cz-stream").disabled = !!t.stream_queue && !me.admin;
    $("cz-unstream").hidden = !(t.on_stream || t.stream_queue);
    $("cz-override-row").hidden = !me.admin || !t.room || t.on_stream;
    const closeBtn = $("cz-close");
    if (closeBtn) closeBtn.hidden = false;
  }
  function wireHost(refresh, closeVerb) {
    const side = async (url, body) => {
      const j = await post(url, body);
      toast(j.reply || j.error || "", !j.ok);
      refresh();
    };
    if (!$("cz-hostbtn")) return;
    $("cz-hostbtn").addEventListener("click", () => openSheet("cz-host"));
    $("cz-push").addEventListener("click", () => side(`/api/casino/t/${tableId}/push`, { room: $("cz-room").value, mode: "add" }));
    $("cz-roomlist").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-unroom]");
      if (b) side(`/api/casino/t/${tableId}/push`, { room: b.dataset.unroom, mode: "remove" });
    });
    $("cz-unpush").addEventListener("click", () => side(`/api/casino/t/${tableId}/push`, { room: null }));
    $("cz-stream").addEventListener("click", () => side(`/api/casino/t/${tableId}/stream`, { on: true, override: !!($("cz-override") && $("cz-override").checked) }));
    $("cz-unstream").addEventListener("click", () => side(`/api/casino/t/${tableId}/stream`, { on: false }));
    $("cz-close").addEventListener("click", () => {
      if (!confirm(game === "holdem" ? T("close_hm_q", "Close this table? Everyone is cashed out.") : T("close_bj_q", "Close this table?"))) return;
      closeSheet("cz-host");
      closeVerb();
    });
  }

  // ── fairness badge + the commitment in the history sheet ──
  function fairness(t) {
    const a = $("cz-fair");
    if (a) {
      if (t.last_revealed) { a.href = `/casino/fair/${t.id}/${t.last_revealed}`; a.hidden = false; }
      else a.hidden = !t.commitment;
      if (!t.last_revealed) a.removeAttribute("href");
      a.title = t.commitment ? T("fair_title", "Provably fair: the next shoe is fixed before anyone bets. Commitment {c}", { c: t.commitment.slice(0, 16) + "…" }) : "";
    }
    const c = $("cz-commit");
    if (c) c.textContent = !t.commitment ? "" : t.game === "holdem" ? T("commit_line_hm", "Hand #{n} commitment: {c} · client seed {s}", { n: t.commit_round, c: t.commitment, s: t.client_seed })
                                                               : T("commit_line", "Round {n} commitment: {c} · client seed {s}", { n: t.commit_round, c: t.commitment, s: t.client_seed });
  }
  function balance(n) {
    const b = $("cz-bal");
    if (!b) return;
    b.hidden = n == null;
    if (n != null) b.querySelector("b").textContent = fmt(n);
  }
  function watching(n) {
    const w = $("cz-watch");
    if (!w) return;
    w.hidden = !n;
    w.querySelector("b").textContent = fmt(n || 0);
    w.title = T("watching_n", "{n} watching", { n: n || 0 });
  }

  // ── the LOBBY (both games; the page's own game first) ──
  // 1.99ov: High Roller tables are a section of their own (💎): only High Rollers open / join them, everyone can watch. Their
  // Hold'em blinds come from the ladder the server sends (limits.holdem.hr_ladder); normal tables stay at 5,000/10,000 or less.
  const BLINDS = ["10/20", "25/50", "50/100", "100/200", "250/500", "1000/2000", "5000/10000"];
  let lobbyTab = game, lobbyData = null, blinds = "25/50", hrBlinds = null;
  function phaseText(t) {
    if (t.game === "holdem") {
      if (t.phase === "between") return t.hand_no ? T("ph_between", "Between hands") : T("ph_waiting", "Waiting for players");
      return T("ph_hand", "Hand #{n} · {street}", { n: t.hand_no, street: streetName(t.phase) });
    }
    if (t.phase === "betting" || t.phase === "idle") return T("ph_betting", "Taking bets");
    return T("ph_round", "Round {n} in play", { n: t.round_no });
  }
  const streetName = (p) => ({ preflop: T("st_preflop", "Pre-flop"), flop: T("st_flop", "Flop"), turn: T("st_turn", "Turn"), river: T("st_river", "River") }[p] || p);
  function tableCard(t, me) {
    const hm = t.game === "holdem";
    const hr = !!t.high_stakes;
    const url = (hm ? "/casino/holdem/t/" : "/casino/blackjack/t/") + encodeURIComponent(t.id);
    const dots = Array.from({ length: t.max_seats }, (_, i) => `<i class="${i < t.players ? "on" : ""}"></i>`).join("");
    const stakes = hm ? T("blinds_v", "Blinds {sb}/{bb}", { sb: fmt(t.sb), bb: fmt(t.bb) }) : T("limits_v", "Bets {min}–{max}", { min: fmt(t.min_bet), max: fmt(t.max_bet) });
    const rs = t.rooms && t.rooms.length ? t.rooms : t.room ? [{ id: t.room, name: t.room_name || t.room }] : [];
    const where = rs.length ? rs.map((r) => `<span class="tag blue">🐸 ${esc(r.name)}</span>`).join("") : `<span class="tag">🌐 ${esc(T("web_only", "Web only"))}</span>`;
    const full = t.players >= t.max_seats;
    const locked = hr && !(me && me.high_roller);              // a High Roller table: everyone else can only watch
    const join = locked ? `<span class="tag lock" title="${esc(T("hr_only_t", "Only High Rollers can play here. Anyone can watch."))}">🔒 ${esc(T("hr_only", "High Rollers only"))}</span>`
      : `<a class="cz-btn gold sm" href="${url}${signed ? (hm ? "?sit=1" : "#bet") : ""}"${full ? ' aria-disabled="true"' : ""}>${esc(full ? T("full", "Full") : T("join", "Join"))}</a>`;
    return `<article class="tcard${hm ? " hm" : ""}${hr ? " hr" : ""}" aria-label="${esc(T("table_of", "{host}'s table", { host: t.host }))}">` +
      `<div class="tcard-h"><span class="ic" aria-hidden="true">${hr ? "💎" : hm ? "🃏" : "🂡"}</span><div><b>${esc(T("table_of", "{host}'s table", { host: t.host }))}</b>` +
      `<small>${esc(hm ? T("g_holdem", "No-Limit Hold'em") : T("g_bj", "Blackjack"))} · ${esc(phaseText(t))}</small></div></div>` +
      `<div class="seatdots" aria-label="${esc(T("seats_v", "{n} of {max} seats taken", { n: t.players, max: t.max_seats }))}">${dots}<span>${fmt(t.players)}/${fmt(t.max_seats)}</span></div>` +
      `<div class="meta"><span class="tag gold">${esc(stakes)}</span>${hr ? `<span class="tag hr">💎 ${esc(T("high_roller", "High Roller"))}</span>` : ""}${where}` +
      `${t.on_stream ? `<span class="tag red">📺 ${esc(T("on_stream", "On Pepe's stream"))}</span>` : t.stream_queue ? `<span class="tag">📺 #${t.stream_queue}</span>` : ""}` +
      `${t.proof ? `<a class="tag green" href="${esc(t.proof)}">🔐 ${esc(T("fair_short", "Fair"))}</a>` : ""}</div>` +
      `<div class="acts">${join}<a class="cz-btn ghost sm" href="${url}">👁 ${esc(T("watch", "Watch"))}</a></div></article>`;
  }
  const blindsLabel = (sb, bb) => (sb >= 100000 ? `${short(sb)}/${short(bb)}` : `${fmt(sb)}/${fmt(bb)}`);
  function renderLobby() {
    const j = lobbyData;
    if (!j) return;
    const all = j.tables || [];
    const me = j.me || null;
    const hr = !!(me && me.high_roller);
    const lim = j.limits || { bj: { min_bet: 100, max_bet: 100000, hr_min_bet: 100000, hr_max_bet: 1000000 }, holdem: { hr_ladder: [] } };
    const inTab = (t) => lobbyTab === "all" || (lobbyTab === "holdem" ? t.game === "holdem" : t.game !== "holdem");
    const list = all.filter((t) => inTab(t) && !t.high_stakes);
    const hrList = all.filter((t) => inTab(t) && t.high_stakes);
    for (const b of document.querySelectorAll(".lob-tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === lobbyTab));
    $("cz-tables").innerHTML = list.length ? list.map((t) => tableCard(t, me)).join("")
      : `<div class="lob-empty">${esc(lobbyTab === "holdem" ? T("none_hm", "No Hold'em table is open. Open one and others can join you.")
                                 : lobbyTab === "bj" ? T("none_bj", "No blackjack table is open. Open one and others can join you.")
                                 : T("none_all", "No tables are open right now. Open one and others can join you."))}</div>`;
    $("cz-hrtables").innerHTML = hrList.length ? hrList.map((t) => tableCard(t, me)).join("")
      : `<div class="lob-empty">${esc(hr ? T("none_hr_mine", "No High Roller table is open. Open one below.") : T("none_hr", "No High Roller table is open right now."))}</div>`;
    $("cz-stat-tables").querySelector("b").textContent = fmt(all.length);
    $("cz-stat-players").querySelector("b").textContent = fmt(all.reduce((s, t) => s + (t.players || 0), 0));
    $("cz-stat-rooms").querySelector("b").textContent = fmt((j.rooms || []).length);
    balance(me ? me.balance : null);
    // open a table: only signed in, only while that game's switch is on
    $("cz-open-bj").hidden = !j.enabled;
    $("cz-open-hm").hidden = !j.hm_enabled;
    $("cz-open-wrap").hidden = !j.enabled && !j.hm_enabled;
    for (const b of document.querySelectorAll(".cz-openbtn")) b.hidden = !signed;
    for (const b of document.querySelectorAll(".cz-signin")) b.hidden = signed;
    $("cz-bjmax").textContent = T("bj_limits_n", "Bets {min}–{max} PAT.", { min: fmt(lim.bj.min_bet), max: fmt(lim.bj.max_bet) });
    const bl = $("cz-blinds");
    if (bl.dataset.v !== BLINDS.join()) {
      bl.dataset.v = BLINDS.join();
      bl.innerHTML = BLINDS.map((b) => `<button type="button" data-b="${b}" aria-pressed="${b === blinds}">${b.split("/").map(fmt).join("/")}</button>`).join("");
    }
    const bb = Number(blinds.split("/")[1]);
    $("cz-buyrange").textContent = T("buy_range", "Buy-in {min}–{max} chips (20–200 big blinds).", { min: fmt(bb * 20), max: fmt(bb * 200) });
    // the 💎 card: High Rollers open tables from it; everyone else sees what it is and where the role comes from
    $("cz-hr-can").hidden = !hr;
    $("cz-hr-locked").hidden = hr;
    $("cz-open-hrbj-go").hidden = !j.enabled;
    $("cz-hrbj").hidden = !j.enabled;
    $("cz-hrbj").textContent = T("hrbj_limits", "Blackjack: bets {min}–{max} PAT.", { min: fmt(lim.bj.hr_min_bet), max: fmt(lim.bj.hr_max_bet) });
    const ladder = (lim.holdem.hr_ladder || []).map(([s, b]) => `${s}/${b}`);
    if (!hrBlinds || !ladder.includes(hrBlinds)) hrBlinds = ladder[0] || null;
    const hb = $("cz-hrblinds");
    for (const id of ["cz-hrblinds-lbl", "cz-hrblinds", "cz-hrbuy", "cz-open-hrhm-go"]) $(id).hidden = !j.hm_enabled || !ladder.length;
    if (hb.dataset.v !== ladder.join()) {
      hb.dataset.v = ladder.join();
      hb.innerHTML = ladder.map((b) => { const [s, g] = b.split("/").map(Number); return `<button type="button" data-b="${b}" aria-pressed="${b === hrBlinds}" aria-label="${esc(T("blinds_v", "Blinds {sb}/{bb}", { sb: fmt(s), bb: fmt(g) }))}">${esc(blindsLabel(s, g))}</button>`; }).join("");
    }
    if (hrBlinds) {
      const hbb = Number(hrBlinds.split("/")[1]);
      $("cz-hrbuy").textContent = T("buy_range", "Buy-in {min}–{max} chips (20–200 big blinds).", { min: fmt(hbb * 20), max: fmt(hbb * 200) });
    }
  }
  async function lobby() {
    try {
      lobbyData = await (await fetch("/api/casino/lobby", { credentials: "same-origin" })).json();
      renderLobby();
    } catch (e) { toast(T("lobby_fail", "Couldn't load the tables."), true); }
  }
  /** g: "bj" | "holdem"; high: a 💎 High Roller table */
  async function openTable(g, high) {
    const btn = high ? $(g === "holdem" ? "cz-open-hrhm-go" : "cz-open-hrbj-go") : $(g === "holdem" ? "cz-open-hm-go" : "cz-open-bj-go");
    btn.disabled = true;
    const body = { game: g === "holdem" ? "holdem" : "bj", idem: idem() };
    if (g === "holdem") body.blinds = high ? hrBlinds : blinds;
    else if (high) body.hr = true;
    const j = await post("/api/casino/open", body);
    btn.disabled = false;
    if (j.ok && j.table) location.href = (g === "holdem" ? "/casino/holdem/t/" : "/casino/blackjack/t/") + j.table + (g === "holdem" ? "?sit=1" : "#bet");
    else toast(j.reply || j.error || T("open_fail", "Couldn't open a table."), true);
  }
  function pickBlinds(box, set) {
    box.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-b]");
      if (!b) return;
      set(b.dataset.b);
      for (const x of box.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
      renderLobby();
    });
  }
  function startLobby() {
    $("cz-lobby").hidden = false;
    for (const b of document.querySelectorAll(".lob-tabs button")) {
      b.addEventListener("click", () => { lobbyTab = b.dataset.tab; renderLobby(); });
    }
    pickBlinds($("cz-blinds"), (v) => { blinds = v; });
    pickBlinds($("cz-hrblinds"), (v) => { hrBlinds = v; });
    $("cz-open-bj-go").addEventListener("click", () => openTable("bj"));
    $("cz-open-hm-go").addEventListener("click", () => openTable("holdem"));
    $("cz-open-hrbj-go").addEventListener("click", () => openTable("bj", true));
    $("cz-open-hrhm-go").addEventListener("click", () => openTable("holdem", true));
    lobby();
    let tm = setInterval(lobby, 4000);
    document.addEventListener("visibilitychange", () => { clearInterval(tm); tm = setInterval(lobby, document.hidden ? 15000 : 4000); if (!document.hidden) lobby(); });
  }

  /** the table loop: poll the table's state about once a second (slower in a background tab); render() draws it */
  function startTable(render) {
    $("cz-table").hidden = false;
    let stopped = false, busy = false, timer = null;
    async function refresh() {
      if (busy) return;
      busy = true;
      try {
        const r = await fetch(`/api/casino/t/${tableId}`, { credentials: "same-origin" });
        if (r.status === 404) {
          toast(T("closed", "That table has closed."), true);
          stopped = true;
          const dock = $("cz-dock");
          if (dock) dock.hidden = true;
          const m = $("cz-msg");
          if (m) m.innerHTML = `${esc(T("closed", "That table has closed."))}<small><a href="${game === "holdem" ? "/casino/holdem" : "/casino/blackjack"}">${esc(T("back_lobby", "Back to the lobby"))}</a></small>`;
          return;
        }
        const d = await r.json();
        if (!d.ok) return;
        setSkew(d.now);
        render(d);
        hostTools(d);
        fairness(d.table);
        balance(d.me ? d.me.balance : null);
        watching(d.watching);
      } catch (e) { /* the next tick tries again */ }
      finally { busy = false; }
    }
    const loop = () => { clearTimeout(timer); if (!stopped) timer = setTimeout(async () => { await refresh(); loop(); }, document.hidden ? 5000 : 1000); };
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { refresh(); loop(); } });
    refresh().then(loop);
    return refresh;
  }

  /** a table move: posts with an idempotency key (a double-click or retry never moves PAT twice), then refreshes */
  function actor(refreshRef) {
    let busy = false;
    return async function act(verb, amount) {
      if (busy) return null;
      busy = true;
      try {
        const j = await post(`/api/casino/t/${tableId}/act`, { verb, amount, idem: idem() });
        if (!j.ok) toast(j.reply || j.error || T("act_fail", "That didn't work."), true);
        else if (j.reply && !j.quiet && !/^(ok|dealing|table open)\.?$/i.test(j.reply)) toast(j.reply, false);
        return j;
      } catch (e) {
        toast(T("net_fail", "Couldn't reach the table. Try again."), true);
        return null;
      } finally {
        busy = false;
        if (refreshRef.fn) refreshRef.fn();
      }
    };
  }

  window.CZ = { $, T, esc, fmt, reduced, idem, post, toast, announce, drawCards, staticCards, cardLabel, chipCls, stackHTML, pileHTML, short, avatarHTML, ringSVG,
                armClock, totalFor, pop, net, openSheet, closeSheet, loadHistory, wireHost, startTable, startLobby, actor, streetName, game, tableId, signed,
                skew: () => skew };
})();
