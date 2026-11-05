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
  const meName = root.dataset.user || "";        // 1.99ajw casino2: your PATV name (the 💸 Tip modal's balance line)

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
    // 1.99ajw casino2 rework: a masked seat (an incognito / hidden player - casino/veil.js) has no picture: a plain frog
    if (s.veil) return `<span class="av veil" aria-hidden="true">🐸${badge ? `<span class="badge">${badge}</span>` : ""}</span>`;
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
    $("cz-roomnow").textContent = attached.length > 1 ? T("rooms_now", "Playing in {n} chat rooms and on the web.", { n: attached.length })
                                : t.room ? T("room_now", "Now in chat room {room} and on the web.", { room: t.room_name || t.room })
                                : T("room_web", "Web only right now.");
    let s;
    if (t.on_stream) s = T("stream_on", "📺 This table is on Pepe's stream.");
    else if (t.stream_queue) s = t.stream_queue === 1 ? T("stream_next", "You're next in line for Pepe's stream.")
                                                      : T("stream_queued", "You're number {n} in line for Pepe's stream.", { n: t.stream_queue });
    else s = T("stream_free", "Ask for Pepe's stream: first come, first served, then a queue.");
    $("cz-streamnow").textContent = s;
    $("cz-stream").hidden = !!t.on_stream;                    // 1.99pc: a web-only table can be on the stream too
    $("cz-stream").textContent = t.stream_queue ? T("stream_waiting", "In the queue") : T("stream_ask", "Put it on Pepe's stream");
    $("cz-stream").disabled = !!t.stream_queue && !me.admin;
    $("cz-unstream").hidden = !(t.on_stream || t.stream_queue);
    $("cz-override-row").hidden = !me.admin || t.on_stream;
    // 1.99pc: adverts - one line + reminders in other rooms, no gameplay there
    const adv = t.adverts || [];
    const advIds = new Set(adv.map((r) => r.id).concat(attached.map((r) => r.id)));
    const asel = $("cz-adroom");
    const aopts = (d.rooms || []).filter((r) => !advIds.has(r.id));
    const asig = aopts.map((r) => r.id + "|" + r.name).join(",");
    if (asel.dataset.v !== asig) {
      asel.dataset.v = asig;
      asel.innerHTML = aopts.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
    }
    asel.hidden = !aopts.length;
    $("cz-adgo").hidden = !aopts.length;
    const alist = $("cz-adlist");
    const alsig = adv.map((r) => r.id + "|" + r.name).join(",");
    if (alist.dataset.v !== alsig) {
      alist.dataset.v = alsig;
      alist.innerHTML = adv.map((r) => `<span>📣 ${esc(r.name)}<button type="button" data-unad="${esc(r.id)}" aria-label="${esc(T("room_remove", "Remove {room}", { room: r.name }))}">×</button></span>`).join("");
    }
    $("cz-adnone").hidden = adv.length > 0 || aopts.length > 0;
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
    $("cz-adgo").addEventListener("click", () => side(`/api/casino/t/${tableId}/advertise`, { room: $("cz-adroom").value, on: true }));
    $("cz-adlist").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-unad]");
      if (b) side(`/api/casino/t/${tableId}/advertise`, { room: b.dataset.unad, on: false });
    });
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
    const where = (rs.length ? rs.map((r) => `<span class="tag blue">🐸 ${esc(r.name)}</span>`).join("") : `<span class="tag">🌐 ${esc(T("web_only", "Web only"))}</span>`) +
      (t.adverts || []).map((r) => `<span class="tag" title="${esc(T("advertised_in", "Advertised in {room}", { room: r.name }))}">📣 ${esc(r.name)}</span>`).join("");
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
    // 1.99sk: two sub-sections (blackjack / Hold'em), each with its limits for everyone; the pickers and buttons (.hr-only)
    // for High Rollers; a game that's switched off drops its sub-section
    for (const el of document.querySelectorAll("#cz-open-hr .hr-only")) el.hidden = !hr;
    $("cz-hr-locked").hidden = hr;
    const ladder = (lim.holdem.hr_ladder || []).map(([s, b]) => `${s}/${b}`);
    $("cz-hrsec-bj").hidden = !j.enabled;
    $("cz-hrsec-hm").hidden = !j.hm_enabled || !ladder.length;
    $("cz-open-hr").classList.toggle("one", $("cz-hrsec-bj").hidden !== $("cz-hrsec-hm").hidden);
    $("cz-hrbj").textContent = T("bj_limits_n", "Bets {min}–{max} PAT.", { min: fmt(lim.bj.hr_min_bet), max: fmt(lim.bj.hr_max_bet) });
    if (ladder.length) {
      const [l0, lN] = [lim.holdem.hr_ladder[0], lim.holdem.hr_ladder[lim.holdem.hr_ladder.length - 1]];
      $("cz-hrhm-lim").textContent = T("hrhm_limits", "Blinds from {lo} up to {hi}.", { lo: blindsLabel(l0[0], l0[1]), hi: blindsLabel(lN[0], lN[1]) });
    }
    if (!hrBlinds || !ladder.includes(hrBlinds)) hrBlinds = ladder[0] || null;
    const hb = $("cz-hrblinds");
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

  // ── 1.99ajw casino2 (owner: "casino tables need clickable names with the usual tipping etc."): a seat's avatar + name open the Room
  // Dock's person menu (room-mod.js PATVRoom.mod: 👤 profile, 💸 Tip with its confirm step, ⚔️ Duel / 🥊 Brawl, moderation only where
  // Pepe gives YOU powers in that pad - the server and Pepe re-check every action). The seats come from GET /api/casino/t/:id/people
  // (signed in; /pads for everyone - the 💬 Chat's list, casino-chat.js): asked when the seats or the rooms change and on a click with
  // an answer older than PEOPLE_CLICK_MS (review F4: someone who just went incognito never gets a menu from a 30-s-old answer; a failed
  // ask opens nothing from an answer older than PEOPLE_FRESH_MS), never by the 1 s poll. 1.99ajw casino2 rework (the owner, 2026-11-04:
  // "just show them masked at the table if incognito is on"): a veiled player's seat is MASKED by the server (casino/veil.js: a frog name
  // or "someone", no picture, a seat id of its own) and looks like every other seat - every seat but your own is the same button, and a
  // masked one opens a small menu that says only that they play incognito (nothing in it unmasks). Pepe (the dealer, or a seat that is
  // his account) has his own small menu: profile, fairness, history, his stream.
  const PEOPLE_FRESH_MS = 30000;
  const PEOPLE_CLICK_MS = 5000;
  const ppl = { sig: null, at: 0, d: null, busy: null };
  let lastView = null;
  const peopleSig = (t) => [(t.seats || []).map((x) => x.seat).join(","), (t.rooms || []).map((r) => r.id).join(","),
                            (t.adverts || []).map((r) => r.id).join(","), t.status].join("|");
  function loadPeople() {
    if (ppl.busy) return ppl.busy;
    ppl.busy = fetch(`/api/casino/t/${tableId}/${signed ? "people" : "pads"}`, { credentials: "same-origin", cache: "no-store" })
      .then((r) => r.json()).then((j) => {
        if (j && j.ok) { ppl.d = j; ppl.at = Date.now(); document.dispatchEvent(new CustomEvent("cz:people", { detail: j })); }
        return ppl.d;
      }).catch(() => ppl.d).then((d) => { ppl.busy = null; return d; });
    return ppl.busy;
  }
  function peopleSync(d) {
    lastView = d;
    if (!d || !d.table) return;
    const sig = peopleSig(d.table);
    if (sig !== ppl.sig) { ppl.sig = sig; loadPeople(); }
  }
  const personOf = (seat) => (ppl.d && ppl.d.seats && seat ? ppl.d.seats[seat] || null : null);
  /** a seat's avatar + plate as a button (the person menu) - every seat alike, a masked one too (rework: a plain seat no longer marks who
   *  is incognito); as they are only signed out (no seat is a button) and on your own seat */
  function seatWho(s, inner) {
    const mine = !!(s && lastView && lastView.me && lastView.me.seat && lastView.me.seat === s.seat);
    if (!signed || !s || !s.seat || mine) return inner;
    return `<button type="button" class="cz-who" data-seat="${esc(s.seat)}" aria-haspopup="menu" aria-label="${esc(T("who_actions", "Actions for {name}", { name: s.name }))}">${inner}</button>`;
  }
  const mods = new Map();          // pad slug ('' = no pad) -> a PATVRoom.mod instance whose Manage panel never shows
  function modFor(slug) {
    if (!window.PATVRoom || !window.PATVRoom.mod) return null;
    let m = mods.get(slug);
    if (!m) {
      const wrap = document.createElement("div"); wrap.hidden = true; wrap.className = "cz-pm-host";   // (update() toggles the section, never this)
      const host = document.createElement("section"); wrap.appendChild(host); document.body.appendChild(wrap);
      // (1.99ajw casino2 rework: the viewer's own named blocks from the people answer - someone you blocked shows ✅ Unblock, no 💸 Tip -
      // and a block / unblock asks again, as the pad's poll does)
      m = window.PATVRoom.mod(host, slug, { signed: true, me: meName || null, dms: true, blk: () => (ppl.d && ppl.d.blk) || null,
                                            onBlock: () => { ppl.at = 0; loadPeople(); } });
      mods.set(slug, m);
    }
    return m;
  }
  // (the Dock's letter bubble colour: chatlog-core.js hue() of the login)
  const hue = (x) => { let h = 0; const s0 = String(x || ""); for (let i = 0; i < s0.length; i++) h = (h * 31 + s0.charCodeAt(i)) % 360; return h; };
  /** the menu's header as the Dock draws it: avatar · name in their cosmetic style · their pad flair (· the login as a second line when
   *  it differs) - review: the same person reads the same in the Dock and on a table */
  function headerLike(menu, u) {
    menu.classList.add("rmd-pm", "cz-pmp");
    const title = menu.querySelector(".pm-pop-n");
    if (!title) return;
    title.textContent = "";
    title.classList.remove("two");
    const row = document.createElement("span"); row.className = "rmd-person";
    const shown = u.display || u.login || "?";
    row.innerHTML = avatarHTML({ name: shown, avatar: u.avatar || null });
    const av = row.querySelector(".av");
    if (av && !u.avatar) av.style.background = "hsl(" + hue(u.login || (u.patv && u.patv.username) || shown) + ",55%,62%)";
    const nm = document.createElement("span"); nm.className = "rmd-person-name";
    const b = document.createElement("b"); b.className = "who"; b.textContent = u.display || u.login || "";
    const st = u.patv && typeof u.patv.style === "string" ? u.patv.style : "";
    if (st) { b.classList.add("cx-name"); b.setAttribute("style", st); }
    nm.appendChild(b);
    const f = u.patv && u.patv.flair;
    if (f && f.name) {
      const fl = document.createElement("span"); fl.className = "ufl"; fl.title = T("who_flair", "Pad flair: {name}", { name: f.name });
      if (/^#[0-9a-f]{6}$/.test(f.color || "")) fl.style.setProperty("--fl", f.color);
      if (/^#[0-9a-f]{6}$/.test(f.ink || "")) fl.style.setProperty("--fli", f.ink);
      if (f.emoji) { const e = document.createElement("span"); e.className = "ufl-e"; e.textContent = f.emoji; fl.appendChild(e); }
      const n = document.createElement("span"); n.className = "ufl-n"; n.textContent = f.name; fl.appendChild(n);
      nm.appendChild(fl);
    }
    row.appendChild(nm); title.appendChild(row);
    if (u.login && String(u.login).toLowerCase() !== String(u.display || "").toLowerCase()) {
      const sm = document.createElement("small"); sm.className = "pm-login"; sm.textContent = u.login; title.appendChild(sm); title.classList.add("two");
    }
  }
  async function personMenu(seat, anchor) {
    if (!ppl.d || Date.now() - ppl.at > PEOPLE_CLICK_MS) await loadPeople();
    if (!ppl.d || Date.now() - ppl.at > PEOPLE_FRESH_MS) { toast(T("who_retry", "Couldn't load that player just now - try again."), true); return; }
    const p = personOf(seat);
    if (!p || p.me) return;
    if (p.veil) { veilMenu(anchor, p); return; }
    if (p.bot) { pepeMenu(anchor); return; }
    const s = lastView && lastView.table ? (lastView.table.seats || []).find((x) => x.seat === seat) : null;
    const pad = p.pad || null, slug = pad ? pad.slug : "";
    const m = modFor(slug);
    if (!m) return;
    m.update({ mod: (pad && pad.mod) || null, room: null });
    const u = { login: p.login || null, display: p.display, patv: p.patv || null, tip: p.tip || null, web: !p.login, avatar: s ? s.avatar : null };
    const pv = pad && pad.pvp && p.login ? { duel: !!pad.pvp.duel, brawl: !!pad.pvp.brawl,
      run: (kind) => { if (window.CZChat && window.CZChat.pvp) window.CZChat.pvp(slug, kind, p.login); } } : null;
    closePepe();
    m.menu(u, anchor, { pvp: pv });
    document.querySelectorAll(".pm-pop").forEach((menu) => { if (menu._anchor === anchor) headerLike(menu, u); });
    if (m.relayout) m.relayout();      // (1.99ajw casino2 rework: room-mod v16 places it again at its decorated size - never taller than the window)
  }

  // Pepe's own menu (the same look): 👤 profile, 🛡️ fairness (the next commitment + the last proof), 📜 history, 📺 his stream; and
  // (1.99ajw casino2 rework) a masked seat's: its frog avatar + label, "incognito player" and one line - nothing that unmasks
  let pepePop = null;
  function closePepe(refocus) {
    if (!pepePop) return;
    const p = pepePop; pepePop = null;
    document.removeEventListener("pointerdown", p._outside, true);
    document.removeEventListener("keydown", p._keys, true);
    p.remove();
    if (refocus && p._anchor && p._anchor.isConnected) p._anchor.focus();
  }
  /** a small menu at anchor: o = {cls, aria, avatar: {name, avatar?, veil?}, name, role, items: [[label, href, fn, why]], note} */
  function smallMenu(anchor, o) {
    if (pepePop && pepePop._anchor === anchor) { closePepe(true); return; }
    closePepe(false);
    const p = document.createElement("div");
    p.className = "pm-pop rmd-pm cz-pmp " + (o.cls || ""); p.setAttribute("role", "dialog");
    p.setAttribute("aria-label", o.aria);
    p._anchor = anchor;
    const hd = document.createElement("div"); hd.className = "pm-pop-h";
    const nm = document.createElement("div"); nm.className = "pm-pop-n"; hd.appendChild(nm);
    const x = document.createElement("button"); x.type = "button"; x.className = "pm-btn pm-x"; x.textContent = "×"; x.setAttribute("aria-label", T("close", "Close"));
    x.addEventListener("click", () => closePepe(true)); hd.appendChild(x);
    p.appendChild(hd);
    const list = document.createElement("div"); list.className = "pm-pop-l";
    if ((o.items || []).length) { list.setAttribute("role", "menu"); list.setAttribute("aria-label", o.aria); }    // (a masked seat's has none)
    for (const [label, href, fn, why] of o.items || []) {
      const b = document.createElement(href ? "a" : "button"); b.className = "pm-pop-i"; b.setAttribute("role", "menuitem"); b.tabIndex = -1;
      b.textContent = label;
      if (href) b.href = href; else { b.type = "button"; b.addEventListener("click", (e) => { e.preventDefault(); closePepe(false); fn(); }); }
      if (why) { const w = document.createElement("small"); w.className = "pm-pop-why"; w.textContent = why; b.appendChild(w); }
      list.appendChild(b);
    }
    if (o.note) list.appendChild(Object.assign(document.createElement("p"), { className: "cz-pm-note", textContent: o.note }));
    p.appendChild(list);
    // (textContent only: a label is a name like any other)
    const row = document.createElement("span"); row.className = "rmd-person";
    row.innerHTML = avatarHTML(o.avatar);
    const nb = document.createElement("span"); nb.className = "rmd-person-name";
    nb.appendChild(Object.assign(document.createElement("b"), { className: "who", textContent: o.name }));
    row.appendChild(nb); nm.appendChild(row);
    nm.appendChild(Object.assign(document.createElement("small"), { className: "pm-login cz-pm-role", textContent: o.role }));
    nm.classList.add("two");
    document.body.appendChild(p);
    pepePop = p;
    const r = anchor.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight, vw = document.documentElement.clientWidth, vh = window.innerHeight;
    let top = r.bottom + 6;
    if (top + h > vh - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    p.style.left = (Math.max(8, Math.min(r.left, vw - w - 8)) + window.scrollX) + "px";
    p.style.top = (top + window.scrollY) + "px";
    const items = () => Array.from(list.querySelectorAll('[role="menuitem"]'));
    p._keys = (e) => {
      if (pepePop !== p) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePepe(true); return; }
      if (!p.contains(document.activeElement)) return;
      const bs = items(), i = bs.indexOf(document.activeElement);
      if (!bs.length) return;
      if (e.key === "ArrowDown") { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
    };
    p._outside = (e) => { if (pepePop === p && !p.contains(e.target) && !anchor.contains(e.target)) closePepe(false); };
    document.addEventListener("keydown", p._keys, true);
    document.addEventListener("pointerdown", p._outside, true);
    const first = items()[0]; if (first) first.focus(); else x.focus();
  }
  function pepeMenu(anchor) {
    const t = (lastView && lastView.table) || {}, pe = (ppl.d && ppl.d.pepe) || {};
    const items = [];
    if (pe.username) items.push(["👤 " + T("pepe_profile", "Pepe's profile"), "/u/" + encodeURIComponent(pe.username)]);
    const proof = t.last_revealed || t.last_hand_revealed || null;
    items.push(["🛡️ " + T("pepe_fair", "Fairness"), proof ? `/casino/fair/${t.id || tableId}/${proof}` : null, proof ? null : () => { const h = $("cz-histbtn"); if (h) h.click(); },
                t.commitment ? T("pepe_fair_next", "next {c}…", { c: String(t.commitment).slice(0, 10) }) : null]);
    items.push(["📜 " + T("pepe_history", "Hand history"), null, () => { const h = $("cz-histbtn"); if (h) h.click(); }]);
    if (t.on_stream && pe.pad) items.push(["📺 " + T("pepe_stream", "On Pepe's stream"), pe.pad]);
    smallMenu(anchor, { cls: "cz-pepe", aria: T("pepe_menu", "Pepe"), avatar: { name: "Pepe", avatar: "/public/img/pepe.png" }, name: "Pepe",
                        role: T("pepe_role", "the dealer · provably fair"), items });
  }
  /** a masked seat's menu: its label and that they play incognito - no profile, no tip, nothing that says who */
  function veilMenu(anchor, p) {
    const name = String(p.display || "someone");
    smallMenu(anchor, { cls: "cz-veilm", aria: T("veil_menu", "Incognito player {name}", { name }), avatar: { name, veil: 1 }, name,
                        role: T("veil_role", "incognito player"), items: [],
                        note: T("veil_note", "Their name and profile stay hidden while they play incognito.") });
  }
  if (tableId) {
    document.body.classList.add("cz-pm");          // (pad-dock.css: the person menu in the Dock's look on the table pages)
    document.addEventListener("click", (e) => {
      const b = e.target && e.target.closest ? e.target.closest(".cz-who") : null;
      if (!b || !root.contains(b)) return;
      e.preventDefault();
      if (b.hasAttribute("data-pepe")) pepeMenu(b); else personMenu(b.getAttribute("data-seat"), b);
    });
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
        peopleSync(d);                 // 1.99ajw casino2 (before render: a seat drawn now knows whether it is a button)
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
                skew: () => skew,
                // 1.99ajw casino2: the person menu (seatWho wraps a seat's avatar + plate), the table's pads / people (casino-chat.js)
                seatWho, personMenu, pepeMenu, people: () => ppl.d, loadPeople, view: () => lastView, me: meName };
})();
