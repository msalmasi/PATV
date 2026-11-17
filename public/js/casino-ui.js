// casino-ui.js — the casino tables' shared front end (D10 design pass, 2026-10-11): helpers for cards (deal / flip
// animations by diffing what's on the felt), chips, avatars, countdown rings tied to the server's deadlines, the toast /
// aria-live announcer, sheets (history, host tools), the table's theme (1.99amf h20: CZ.theme), and the casino LOBBY (both
// games; its theme picker). casinobj.js and casinohm.js draw their own tables on top of it. Strings: __t("js.casino.*",
// English default) - the defaults equal locales/en.json.
// h22 (1.99alz): + the lobby's 🏁 Sit & Go section and its Create sheet (/api/casino/lobby -> sng), and the Sit & Go countdowns
// ([data-sngdl], once a second on the server's clock) the table page's header (casinohm.js) uses too.
// h22 phase 2 (1.99amj): a scheduled tournament's table polls every 2 s while it isn't your turn (1 s on your turn, 5 s hidden).
// 1.99aoj: roulette is the lobby's third game - its 🛞 tab (#roulette), the wheels as table cards (wheelCard), "Open a wheel".
(function () {
  "use strict";
  const root = document.getElementById("cb");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  // (without the page's __t - a test's vm - a plural default {"one", "other"} picks by vars.count as __t does in English)
  const T = (k, d, v) => (window.__t ? window.__t("js.casino." + k, d, v)
    : String(d && typeof d === "object" ? (v && Number(v.count) === 1 && d.one != null ? d.one : d.other) : d).replace(/\{!?(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : m)));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lang = document.documentElement.lang || "en";
  const fmt = (n) => { try { return Math.trunc(Number(n) || 0).toLocaleString(lang); } catch (e) { return String(Math.trunc(Number(n) || 0)); } };
  const reduced = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const idem = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const game = ["roulette", "holdem"].includes(root.dataset.game) ? root.dataset.game : "bj";
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
  // 1.99alq train3 (owner answer 1): a one-time notice from the table (e.g. the Hold'em timeout rule at your first buy-in) -
  // it stays until closed (a toast would be gone in 4 s)
  function note(text) {
    const el = $("cz-note");
    if (!el || !text) return;
    el.querySelector(".cz-note-txt").textContent = text;
    el.hidden = false;
    const btn = el.querySelector("button");
    if (btn && !btn.dataset.w) { btn.dataset.w = "1"; btn.addEventListener("click", () => { el.hidden = true; }); }
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
    // 1.99aoj (review): a room where this game is off can't take it (the server refuses a wheel's push there: rooms[].off, roulette
    // only - casino/service.js freshRooms) - greyed and named like a busy one, never a choice that always fails
    const why = (r) => (r.busy ? T("room_busy", "has a table") : r.off ? T("rl_room_off", "roulette is off here") : "");
    const want = rooms.map((r) => r.id + "|" + r.name + "|" + (r.busy ? 1 : 0) + (r.off ? 1 : 0)).join(",");
    if (sel.dataset.v !== want) {
      sel.dataset.v = want;
      sel.innerHTML = rooms.map((r) => `<option value="${esc(r.id)}"${why(r) ? " disabled" : ""}>${esc(r.name)}${why(r) ? " · " + esc(why(r)) : ""}</option>`).join("");
    }
    const list = $("cz-roomlist");
    const lsig = attached.map((r) => r.id + "|" + r.name).join(",");
    if (list && list.dataset.v !== lsig) {
      list.dataset.v = lsig;
      list.innerHTML = attached.map((r) => `<span>🐸 ${esc(r.name)}<button type="button" data-unroom="${esc(r.id)}" aria-label="${esc(T("room_remove", "Remove {room}", { room: r.name }))}">×</button></span>`).join("");
    }
    $("cz-roomnone").hidden = rooms.length > 0 || attached.length > 0;
    $("cz-room").hidden = !rooms.length;
    $("cz-push").hidden = !rooms.some((r) => !why(r));               // (review: nothing left to pick - no Add button)
    $("cz-unpush").hidden = !attached.length;
    $("cz-roomnow").textContent = attached.length > 1 ? T("rooms_now", "Playing in {n} chat rooms and on the web.", { n: attached.length })
                                : t.room ? T("room_now", "Now in chat room {room} and on the web.", { room: t.room_name || t.room })
                                : T("room_web", "Web only right now.");
    let s;
    if (t.on_stream) s = game === "roulette" ? (t.stream_pinned ? T("rl_stream_pinned", "📌 This wheel is pinned on Pepe's stream: it stays there until it closes or is taken off.")
                                                                : T("rl_stream_on", "📺 This wheel is on Pepe's stream.")) : T("stream_on", "📺 This table is on Pepe's stream.");
    else if (t.stream_queue) s = t.stream_queue === 1 ? T("stream_next", "You're next in line for Pepe's stream.")
                                                      : T("stream_queued", "You're number {n} in line for Pepe's stream.", { n: t.stream_queue });
    else s = T("stream_free", "Ask for Pepe's stream: first come, first served, then a queue.");
    $("cz-streamnow").textContent = s;
    $("cz-stream").hidden = !!t.on_stream;                    // 1.99pc: a web-only table can be on the stream too
    $("cz-stream").textContent = t.stream_queue ? T("stream_waiting", "In the queue") : T("stream_ask", "Put it on Pepe's stream");
    $("cz-stream").disabled = !!t.stream_queue && !me.admin;
    $("cz-unstream").hidden = !(t.on_stream || t.stream_queue);
    $("cz-override-row").hidden = !me.admin || t.on_stream;
    // 1.99aoj (review, D7): an admin's 📌 pin of a wheel on Pepe's stream (no 5-minute idle drop, so the OBS board stays with it) - the box
    // beside "Put it on Pepe's stream", the 📌 button once it is there unpinned (the partial draws both on a wheel's page only)
    const pinRow = $("cz-pin-row"), pinNow = $("cz-pinnow"), pinner = !!me.admin && game === "roulette";
    if (pinRow) pinRow.hidden = !pinner || !!t.on_stream;
    if (pinNow) pinNow.hidden = !(pinner && t.on_stream && !t.stream_pinned);
    // 1.99pc: adverts - one line + reminders in other rooms, no gameplay there
    const adv = t.adverts || [];
    const advIds = new Set(adv.map((r) => r.id).concat(attached.map((r) => r.id)));
    const asel = $("cz-adroom");
    const aopts = (d.rooms || []).filter((r) => !advIds.has(r.id));
    // 1.99aoj (review): the server refuses an advert in a room where the table's game is off (advertise: the room's game flags - a
    // wheel's rooms[].off too): greyed and named, and no Advertise button once nothing is left to pick
    const aoff = (r) => !!(r.off || (r.games && r.games[game] === false));
    const offWhy = () => (game === "roulette" ? T("rl_room_off", "roulette is off here") : T("room_game_off", "this game is off here"));
    const asig = aopts.map((r) => r.id + "|" + r.name + "|" + (aoff(r) ? 1 : 0)).join(",");
    if (asel.dataset.v !== asig) {
      asel.dataset.v = asig;
      asel.innerHTML = aopts.map((r) => `<option value="${esc(r.id)}"${aoff(r) ? " disabled" : ""}>${esc(r.name)}${aoff(r) ? " · " + esc(offWhy()) : ""}</option>`).join("");
    }
    asel.hidden = !aopts.length;
    $("cz-adgo").hidden = !aopts.some((r) => !aoff(r));
    const alist = $("cz-adlist");
    const alsig = adv.map((r) => r.id + "|" + r.name).join(",");
    if (alist.dataset.v !== alsig) {
      alist.dataset.v = alsig;
      alist.innerHTML = adv.map((r) => `<span>📣 ${esc(r.name)}<button type="button" data-unad="${esc(r.id)}" aria-label="${esc(T("room_remove", "Remove {room}", { room: r.name }))}">×</button></span>`).join("");
    }
    $("cz-adnone").hidden = adv.length > 0 || aopts.length > 0;
    const closeBtn = $("cz-close");
    if (closeBtn) closeBtn.hidden = !!t.tourney;          // (h22: a sit & go isn't closed - an admin cancels it, with full refunds)
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
    $("cz-stream").addEventListener("click", () => side(`/api/casino/t/${tableId}/stream`, { on: true, override: !!($("cz-override") && $("cz-override").checked),
                                                                                          pin: !!($("cz-pin") && $("cz-pin").checked) }));
    if ($("cz-pinnow")) $("cz-pinnow").addEventListener("click", () => side(`/api/casino/t/${tableId}/stream`, { on: true, pin: true }));   // (1.99aoj review, D7)
    $("cz-unstream").addEventListener("click", () => side(`/api/casino/t/${tableId}/stream`, { on: false }));
    $("cz-close").addEventListener("click", () => {
      // 1.99aoj: a wheel is closed as a wheel (casino/roulette.js "end": the layout's bets are refunded; a spin in the air lands first)
      if (!confirm(game === "holdem" ? T("close_hm_q", "Close this table? Everyone is cashed out.")
                   : game === "roulette" ? T("rl_close_q", "Close this wheel? Bets on the layout come back; a spin already running lands first.") : T("close_bj_q", "Close this table?"))) return;
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
      a.title = t.game === "roulette" && t.commitment ? T("rl_fair_title", "The next spin is fixed before anyone bets. Commitment {c}", { c: t.commitment.slice(0, 16) + "…" }) : t.commitment ? T("fair_title", "Provably fair: the next shoe is fixed before anyone bets. Commitment {c}", { c: t.commitment.slice(0, 16) + "…" }) : "";
    }
    const c = $("cz-commit");
    if (c) c.textContent = !t.commitment ? "" : t.game === "roulette" ? T("rl_commit_line", "Spin {n} commitment: {c} · client seed {s}", { n: t.commit_round, c: t.commitment, s: t.client_seed }) : t.game === "holdem" ? T("commit_line_hm", "Hand #{n} commitment: {c} · client seed {s}", { n: t.commit_round, c: t.commitment, s: t.client_seed })
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

  // ── 1.99amf h20: the table's theme (casino/themes.js - presentation only). A themed table's page carries the theme's CSS
  // (public/css/casino-themes.css, every rule under .cz-theme-<id> on #cz-table), its art (<template id="cz-theme-<id>">: the
  // scene behind the felt + the sign) and the sound cues (casino-sound.js); a classic page has none of it. Every render calls
  // theme(t, at) - at = {scene: where the scene goes (first child), sign: what the sign goes before}: the class and the art
  // change only when the theme does (the switch going off turns a saloon table classic), the sound cues see every state.
  const THEME_NAME = { classic: () => T("theme_classic", "Classic"), saloon: () => T("theme_saloon", "Saloon") };
  const THEME_ICON = { classic: "🃏", saloon: "🤠" };
  const themeName = (id) => (THEME_NAME[id] ? THEME_NAME[id]() : String(id || ""));
  let themeOn = null;
  function theme(t, at) {
    const id = t && typeof t.theme === "string" && /^[a-z]{1,20}$/.test(t.theme) ? t.theme : "classic";
    const wrap = $("cz-table");
    if (wrap && themeOn !== id) {
      themeOn = id;
      for (const c of Array.from(wrap.classList)) if (c.indexOf("cz-theme-") === 0) wrap.classList.remove(c);
      for (const el of Array.from(wrap.querySelectorAll("[data-cz-art]"))) el.remove();
      const tpl = id !== "classic" ? $("cz-theme-" + id) : null;
      if (tpl && tpl.content) {
        wrap.classList.add("cz-theme-" + id);
        const put = (sel, place) => { const src = tpl.content.querySelector(sel); if (src) { const el = src.cloneNode(true); el.setAttribute("data-cz-art", ""); place(el); } };
        if (at && at.scene) put(".cz-scene", (el) => at.scene.insertBefore(el, at.scene.firstChild));
        if (at && at.sign && at.sign.parentNode) put(".cz-sign", (el) => at.sign.parentNode.insertBefore(el, at.sign));
      }
    }
    if (window.CZSound) window.CZSound.update(id, t);
    return id;
  }

  // ── the LOBBY (both games; the page's own game first) ──
  // 1.99ov: High Roller tables are a section of their own (💎): only High Rollers open / join them, everyone can watch. Their
  // Hold'em blinds come from the ladder the server sends (limits.holdem.hr_ladder); normal tables stay at 5,000/10,000 or less.
  const BLINDS = ["10/20", "25/50", "50/100", "100/200", "250/500", "1000/2000", "5000/10000"];
  let lobbyTab = game, lobbyData = null, blinds = "25/50", hrBlinds = null, lobbyTheme = "classic";
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
    return `<article class="tcard${hm ? " hm" : ""}${hr ? " hr" : ""}" data-id="${esc(t.id)}" aria-label="${esc(T("table_of", "{host}'s table", { host: t.host }))}">` +
      `<div class="tcard-h"><span class="ic" aria-hidden="true">${hr ? "💎" : hm ? "🃏" : "🂡"}</span><div><b>${esc(T("table_of", "{host}'s table", { host: t.host }))}</b>` +
      `<small>${esc(hm ? T("g_holdem", "No-Limit Hold'em") : T("g_bj", "Blackjack"))} · ${esc(phaseText(t))}</small></div></div>` +
      `<div class="seatdots" aria-label="${esc(T("seats_v", "{n} of {max} seats taken", { n: t.players, max: t.max_seats }))}">${dots}<span>${fmt(t.players)}/${fmt(t.max_seats)}</span></div>` +
      `<div class="meta"><span class="tag gold">${esc(stakes)}</span>${hr ? `<span class="tag hr">💎 ${esc(T("high_roller", "High Roller"))}</span>` : ""}` +
      `${t.theme && t.theme !== "classic" ? `<span class="tag">${THEME_ICON[t.theme] || "🎨"} ${esc(themeName(t.theme))}</span>` : ""}${where}` +
      `${t.on_stream ? `<span class="tag red">📺 ${esc(T("on_stream", "On Pepe's stream"))}</span>` : t.stream_queue ? `<span class="tag">📺 #${t.stream_queue}</span>` : ""}` +
      `${t.proof ? `<a class="tag green" href="${esc(t.proof)}">🔐 ${esc(T("fair_short", "Fair"))}</a>` : ""}</div>` +
      `<div class="acts">${join}<a class="cz-btn ghost sm" href="${url}">👁 ${esc(T("watch", "Watch"))}</a></div></article>`;
  }
  // ── 1.99aoj: a 🛞 wheel's card - the table card's markup (.tcard / .tcard-h / .meta / .acts) with the wheel's own lines:
  // "Pepe's wheel" (the always-on lobby wheel) or "{host}'s wheel", the live phase + its countdown (the lobby answer's deadline /
  // land_at on the server's clock), the last pockets in the felt's colours where the seat dots go, who's on the layout, the limits
  // (the per-spin maximum spelled out), 💎, rooms / web, 📺, 🔐 Fair; Play + 👁 Watch. Display only: nothing here moves PAT, and the
  // host is the server's masked name (V.hostName).
  const RL_RED = () => (window.PATVRlBets && Array.isArray(window.PATVRlBets.red) ? window.PATVRlBets.red : null);
  /** a pocket's colour class from the client's red list (PATVRlBets.red - never the server's "green" for 0); "" when it isn't loaded */
  function pocketColor(n) {
    const red = RL_RED();
    if (!red) return "";
    return n === 0 ? "zero" : red.indexOf(n) >= 0 ? "red" : "black";
  }
  function pocketWord(n) {
    const c = pocketColor(n);
    return c === "zero" ? T("rl_pocket_zero", "{n} green", { n }) : c === "red" ? T("rl_pocket_red", "{n} red", { n }) : c === "black" ? T("rl_pocket_black", "{n} black", { n }) : String(n);
  }
  function pocketHTML(n, newest) {
    const w = pocketWord(n), c = pocketColor(n);
    return `<span class="rl-pocket${c ? " " + c : ""}${newest ? " newest" : ""}" role="img" aria-label="${esc(w)}" title="${esc(w)}">${esc(n)}</span>`;
  }
  const outcomeWord = (n) => (n === 0 ? T("rl_zero", "0 · Zero") : pocketColor(n) === "red" ? T("rl_red_word", "{n} ◆ Red", { n }) : pocketColor(n) === "black" ? T("rl_black_word", "{n} ● Black", { n }) : String(n));
  const lastPockets = (t) => (Array.isArray(t.last) ? t.last : []).filter((n) => Number.isInteger(n) && n >= 0 && n <= 36);
  /** the wheel's live line (HTML): Bets open (· its countdown once the first chip starts the clock) / No more bets · the landing / Result · the pocket */
  function wheelPhase(t) {
    const cd = (dl) => (Number(dl) > 0 ? ` · <b data-rldl="${Number(dl)}"></b>` : "");
    if (t.phase === "spinning") return esc(T("rl_spinning", "No more bets")) + cd(t.land_at);
    if (t.phase === "result") {
      const l = lastPockets(t), n = l.length ? l[l.length - 1] : null;
      return esc(T("rl_result", "Result")) + (n != null ? " · " + esc(outcomeWord(n)) : "");
    }
    return esc(T("rl_open", "Bets open")) + (t.phase === "betting" ? cd(t.deadline) : "");
  }
  function wheelCard(t, me) {
    const hr = !!t.high_stakes;
    const url = "/casino/roulette/t/" + encodeURIComponent(t.id);
    const title = t.lobby ? T("rl_wheel_pepe", "Pepe's wheel") : T("rl_wheel_of", "{host}'s wheel", { host: t.host });
    const last = lastPockets(t).slice(-8).reverse();                     // newest first, with the gold ring
    const pockets = last.length ? last.map((n, i) => pocketHTML(n, i === 0)).join("") : `<span class="none">${esc(T("rl_no_spins", "No spins yet"))}</span>`;
    const players = Number(t.players) || 0;
    const tally = T("rl_card_tally", { "one": "{n} player · {pat} PAT on the layout", "other": "{n} players · {pat} PAT on the layout" },
                    { n: fmt(players), pat: fmt(t.staked), count: players });
    const limits = T("rl_card_limits", "Min {min} · Straight {straight} · {spin} a spin", { min: fmt(t.min_bet), straight: fmt(t.max_straight), spin: fmt(t.max_bet) });
    const rs = t.rooms && t.rooms.length ? t.rooms : t.room ? [{ id: t.room, name: t.room_name || t.room }] : [];
    const where = (rs.length ? rs.map((r) => `<span class="tag blue">🐸 ${esc(r.name)}</span>`).join("") : `<span class="tag">🌐 ${esc(T("web_only", "Web only"))}</span>`) +
      (t.adverts || []).map((r) => `<span class="tag" title="${esc(T("advertised_in", "Advertised in {room}", { room: r.name }))}">📣 ${esc(r.name)}</span>`).join("");
    const full = !!t.max_seats && players >= t.max_seats;
    const locked = hr && !(me && me.high_roller);              // a 💎 wheel: everyone else can only watch
    const play = locked ? `<span class="tag lock" title="${esc(T("hr_only_t", "Only High Rollers can play here. Anyone can watch."))}">🔒 ${esc(T("hr_only", "High Rollers only"))}</span>`
      : `<a class="cz-btn gold sm" href="${url}"${full ? ' aria-disabled="true"' : ""}>${esc(full ? T("full", "Full") : T("rl_play", "Play"))}</a>`;
    return `<article class="tcard rl${hr ? " hr" : ""}" data-id="${esc(t.id)}" aria-label="${esc(title)}">` +
      `<div class="tcard-h"><span class="ic" aria-hidden="true">${hr ? "💎" : "🛞"}</span><div><b>${esc(title)}</b>` +
      `<small>${esc(T("g_rl", "Single-zero roulette"))} · ${wheelPhase(t)}</small></div></div>` +
      `<div class="rl-last" role="group" aria-label="${esc(T("rl_recent_order", "Last spins, newest first"))}">${pockets}</div>` +   // (review: the order is said, not only drawn)
      `<p class="rl-tally">${esc(tally)}</p>` +
      `<div class="meta"><span class="tag gold">${esc(limits)}</span>${hr ? `<span class="tag hr">💎 ${esc(T("high_roller", "High Roller"))}</span>` : ""}` +
      `${t.lobby ? `<span class="tag">${esc(T("rl_lobby", "Lobby wheel"))}</span>` : ""}${where}` +
      `${t.on_stream ? `<span class="tag red">📺 ${esc(T("on_stream", "On Pepe's stream"))}</span>` : t.stream_queue ? `<span class="tag">📺 #${t.stream_queue}</span>` : ""}` +
      `${t.proof ? `<a class="tag green" href="${esc(t.proof)}">🔐 ${esc(T("fair_short", "Fair"))}</a>` : ""}</div>` +
      `<div class="acts">${play}<a class="cz-btn ghost sm" href="${url}">👁 ${esc(T("watch", "Watch"))}</a></div></article>`;
  }
  const cardFor = (t, me) => (t.game === "roulette" ? wheelCard(t, me) : tableCard(t, me));
  const TABS = ["all", "bj", "holdem", "roulette"];
  const isLobbyWheel = (t) => t.game === "roulette" && !!t.lobby;
  const blindsLabel = (sb, bb) => (sb >= 100000 ? `${short(sb)}/${short(bb)}` : `${fmt(sb)}/${fmt(bb)}`);
  /** innerHTML only when it changed (a 4 s poll with nothing new keeps the cards as they are). (review) A redraw keeps the keyboard
   *  focus: a wheel's card changes on nearly every poll during play (players, staked, phase, its clock), so a focused link or button
   *  in a card (data-id = its table) is found again in the redrawn card - the same control by its tag and class (Play / Join, Watch,
   *  Fair: one of each in a card; a Fair link's round moves on), else the card's first one - and focused without a scroll. A card
   *  that has gone (or moved to the other grid) loses it. */
  function fill(el, html) {
    if (el.dataset.v === html) return;
    const a = document.activeElement;
    const card = a && a !== el && el.contains(a) && a.closest ? a.closest("[data-id]") : null;
    const was = card ? { id: card.getAttribute("data-id"), tag: a.tagName, cls: a.getAttribute("class") || "" } : null;
    el.dataset.v = html;
    el.innerHTML = html;
    if (!was) return;
    const again = Array.from(el.querySelectorAll("[data-id]")).find((c) => c.getAttribute("data-id") === was.id);
    const ctl = again ? Array.from(again.querySelectorAll("a, button")) : [];
    const hit = ctl.find((x) => x.tagName === was.tag && (x.getAttribute("class") || "") === was.cls) || ctl[0];
    if (hit && typeof hit.focus === "function") { try { hit.focus({ preventScroll: true }); } catch (e) { hit.focus(); } }
  }
  function renderLobby() {
    const j = lobbyData;
    if (!j) return;
    // 1.99aoj: roulette is a game of the lobby while it's open to this viewer (the lobby answer's roulette.on; the server drops
    // the wheel rows otherwise): its tab, its cards, its open cards
    const rlOn = !!(j.roulette && j.roulette.on);
    if (!rlOn && lobbyTab === "roulette") lobbyTab = game;
    const rlTab = document.querySelector('.lob-tabs button[data-tab="roulette"]');
    if (rlTab) { rlTab.hidden = !rlOn; rlTab.parentNode.classList.toggle("four", rlOn); }     // (.four: a phone's 2 x 2 switcher)
    // 1.99aof (UI-12): with the wheel on, the lobby's header and hero name it too
    if (rlOn) {
      const sub = document.querySelector(".cz-brand small"), tag = document.querySelector("#cz-lobby .lob-hero p");
      if (sub && !tableId) sub.textContent = T("lobby_sub_rl", "Blackjack, Hold'em and roulette with your PAT");
      if (tag) tag.textContent = T("lobby_tag_rl", "Blackjack, No-Limit Hold'em and single-zero roulette with your PAT. Play right here, or push a table to a pad's chat room so room players sit at the same felt. Every shuffle and every spin is provably fair. For fun only: PAT is points with no cash value, and every win is paid in PAT.");
    }
    // (an older answer, or roulette shut: no wheel rows)
    const all = (j.tables || []).filter((t) => rlOn || t.game !== "roulette");
    const me = j.me || null;
    const hr = !!(me && me.high_roller);
    const lim = j.limits || { bj: { min_bet: 100, max_bet: 100000, hr_min_bet: 100000, hr_max_bet: 1000000 }, holdem: { hr_ladder: [] } };
    const inTab = (t) => lobbyTab === "all" || (lobbyTab === "holdem" ? t.game === "holdem" : lobbyTab === "roulette" ? t.game === "roulette" : t.game !== "holdem" && t.game !== "roulette");
    // the lobby wheel first ("all" and the roulette tab), the rest as the server lists them
    const ordered = all.slice().sort((a, b) => isLobbyWheel(b) - isLobbyWheel(a));
    const list = ordered.filter((t) => inTab(t) && !t.high_stakes);
    const hrList = ordered.filter((t) => inTab(t) && t.high_stakes);
    for (const b of document.querySelectorAll(".lob-tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === lobbyTab));
    fill($("cz-tables"), list.length ? list.map((t) => cardFor(t, me)).join("")
      : `<div class="lob-empty">${esc(lobbyTab === "holdem" ? T("none_hm", "No Hold'em table is open. Open one and others can join you.")
                                 : lobbyTab === "bj" ? T("none_bj", "No blackjack table is open. Open one and others can join you.")
                                 : lobbyTab === "roulette" ? T("none_rl", "No wheel is open right now. Open one and others can join you.")
                                 : T("none_all", "No tables are open right now. Open one and others can join you."))}</div>`);
    fill($("cz-hrtables"), hrList.length ? hrList.map((t) => cardFor(t, me)).join("")
      : `<div class="lob-empty">${esc(hr ? T("none_hr_mine", "No High Roller table is open. Open one below.") : T("none_hr", "No High Roller table is open right now."))}</div>`);
    tickSng();                                                   // (a new card's countdown shows at once, not on the next tick)
    $("cz-stat-tables").querySelector("b").textContent = fmt(all.length);
    $("cz-stat-players").querySelector("b").textContent = fmt(all.reduce((s, t) => s + (t.players || 0), 0));
    $("cz-stat-rooms").querySelector("b").textContent = fmt((j.rooms || []).length);
    balance(me ? me.balance : null);
    // open a table: only signed in, only while that game's switch is on
    $("cz-open-bj").hidden = !j.enabled;
    $("cz-open-hm").hidden = !j.hm_enabled;
    // (review: roulette.open - may this viewer open a web wheel of their own (rl_web_open); hr_open - are the 💎 wheels open at all
    // (rl_hr_spin_cap > 0). An older answer has neither: open, as before)
    const rlCanOpen = rlOn && j.roulette.open !== false, rlHrOpen = rlCanOpen && j.roulette.hr_open !== false;
    const rlOpen = $("cz-open-rl");
    if (rlOpen) rlOpen.hidden = !rlCanOpen;
    $("cz-open-wrap").hidden = !j.enabled && !j.hm_enabled && !rlCanOpen;
    const rlLim = (lim.roulette || null);
    if (rlOn && rlLim && $("cz-rlmax")) $("cz-rlmax").textContent = T("rl_open_limits", "Bets from {min} PAT · up to {spin} PAT a spin, all your bets together.", { min: fmt(rlLim.min_bet), spin: fmt(rlLim.max_spin) });
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
    // 1.99amf h20: the table theme picker - only when the switch lets this viewer pick (the lobby's themes.pick); one choice for every
    // Open button below (a game the theme isn't drawn for opens classic)
    const tlist = j.themes && j.themes.pick ? j.themes.list || [] : [];
    const tpick = $("cz-themepick");
    if (tpick) {
      tpick.hidden = !signed || tlist.length < 2;
      if (!tlist.some((x) => x.id === lobbyTheme)) lobbyTheme = "classic";
      const tb = $("cz-themes");
      const tsig = tlist.map((x) => x.id).join();
      if (tb.dataset.v !== tsig) {
        tb.dataset.v = tsig;
        tb.innerHTML = tlist.map((x) => `<button type="button" data-th="${esc(x.id)}" aria-pressed="false">${THEME_ICON[x.id] || "🎨"} ${esc(themeName(x.id))}</button>`).join("");
      }
      for (const b of tb.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.th === lobbyTheme));
      const cur = tlist.find((x) => x.id === lobbyTheme);
      $("cz-themenote").textContent = !cur || cur.default ? "" : T("theme_note", "Looks only: the rules, the cards, the odds and every PAT amount stay the same.") +
        (cur.games.includes("bj") ? "" : " " + T("theme_bj_classic", "Blackjack tables open in Classic for now.")) +
        (rlOn ? " " + T("theme_rl_classic", "Roulette wheels open in Classic.") : "");   // (1.99aoj: a wheel opens classic - the server takes no theme)
    }
    // the 💎 card: High Rollers open tables from it; everyone else sees what it is and where the role comes from
    // 1.99sk: two sub-sections (blackjack / Hold'em), each with its limits for everyone; the pickers and buttons (.hr-only)
    // for High Rollers; a game that's switched off drops its sub-section
    for (const el of document.querySelectorAll("#cz-open-hr .hr-only")) el.hidden = !hr;
    $("cz-hr-locked").hidden = hr;
    const ladder = (lim.holdem.hr_ladder || []).map(([s, b]) => `${s}/${b}`);
    $("cz-hrsec-bj").hidden = !j.enabled;
    $("cz-hrsec-hm").hidden = !j.hm_enabled || !ladder.length;
    // 1.99aoj (D2): the 💎 wheel's sub-section (its limits from limits.roulette.hr) while roulette is open to this viewer
    const hrRl = $("cz-hrsec-rl"), rlHr = rlLim && rlLim.hr ? rlLim.hr : null;
    if (hrRl) hrRl.hidden = !rlHrOpen || !rlHr;
    if (hrRl && !hrRl.hidden) $("cz-hrrl").textContent = T("rl_open_limits", "Bets from {min} PAT · up to {spin} PAT a spin, all your bets together.", { min: fmt(rlHr.min_bet), spin: fmt(rlHr.max_spin) });
    // (review) the note under the sub-sections names the 💎 wheels too while theirs shows (the partial draws both; the page guessed one)
    const lockT = $("cz-hr-locked-t"), lockRl = $("cz-hr-locked-rl");
    if (lockT && lockRl) { const w = !!(hrRl && !hrRl.hidden); lockT.hidden = w; lockRl.hidden = !w; }
    const shownSecs = ["cz-hrsec-bj", "cz-hrsec-hm", "cz-hrsec-rl"].filter((id) => $(id) && !$(id).hidden).length;
    $("cz-open-hr").hidden = shownSecs === 0;                  // (review: no game of it open here - no empty 💎 card)
    $("cz-open-hr").classList.toggle("one", shownSecs === 1);
    $("cz-open-hr").classList.toggle("three", shownSecs === 3);
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
    renderSng(j);
  }

  // ── h22 (1.99alz): 🏁 Sit & Go - the lobby's section and its Create sheet (/api/casino/lobby -> sng, casino/tourney.js). A card: seats
  // taken, the entry (buy-in + fee), the structure, the countdown or the level, the prizes; Register / Unregister (each with its own
  // idempotency key: a double click never holds twice) and Watch. Hidden on the blackjack tab and while the switch is off (unless one
  // is still open - leaving it always works).
  const mmss = (ms) => { const n = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0"); };
  // (1.99aoj: + a wheel card's countdown, [data-rldl] - the lobby answer's `now` sets the skew)
  function tickSng() {
    const now = Date.now() - skew;
    for (const el of document.querySelectorAll("[data-sngdl]")) el.textContent = mmss(Number(el.dataset.sngdl) - now);
    for (const el of document.querySelectorAll("[data-rldl]")) el.textContent = mmss(Number(el.dataset.rldl) - now);
  }
  setInterval(tickSng, 1000);
  const medal = (i) => ["🥇", "🥈", "🥉"][i] || "#" + (i + 1);
  const prizeTags = (prizes) => (prizes || []).map((p, i) => `<span class="tag" aria-label="${esc(T("sng_place_prize", "Place {n}: {amount} PAT", { n: i + 1, amount: fmt(p) }))}">${medal(i)} ${fmt(p)}</span>`).join("");
  const clockHTML = (dl) => `<b data-sngdl="${Number(dl)}"></b>`;      // (filled by tickSng: the card's HTML stays the same from second to second)
  function sngState(r) {
    if (r.status === "registering") {
      return r.countdown_at ? esc(T("sng_starts_in", "Starts in")) + " " + clockHTML(r.countdown_at)
                            : esc(r.start_at ? T("sng_starts_at", "Starts at {n} players", { n: r.start_at }) : T("sng_starts_full", "Starts when full"));
    }
    if (r.status === "running") return esc(T("sng_running_n", "Level {n} · {sb}/{bb} · {left} left", { n: r.level, sb: fmt(r.sb), bb: fmt(r.bb), left: r.players_left }));
    if (r.status === "settling") return esc(T("sng_paying", "Paying out…"));
    if (r.status === "finished") return esc(r.winner ? T("sng_won_by", "🏆 {name} won", { name: r.winner }) : T("sng_over", "Finished"));
    return esc(T("sng_called_off", "Called off — every entry refunded"));
  }
  function sngCard(r, sg) {
    const url = "/casino/holdem/t/" + encodeURIComponent(r.id);
    const reg = r.status === "registering";
    const n = reg ? r.registered : r.field || r.registered;
    const dots = Array.from({ length: r.size }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("");
    let act = "";
    if (reg && signed) {
      act = r.me ? `<button type="button" class="cz-btn ghost sm" data-sngact="unregister" data-id="${esc(r.id)}">${esc(T("sng_unregister", "Unregister"))}</button>`
        : r.registered >= r.size ? `<span class="tag">${esc(T("full", "Full"))}</span>`
        : sg.can_create ? `<button type="button" class="cz-btn gold sm" data-sngact="register" data-id="${esc(r.id)}">${esc(T("sng_register_n", "Register · {n} PAT", { n: fmt(r.entry) }))}</button>` : "";
    }
    const where = (r.rooms || []).map((x) => `<span class="tag blue">🐸 ${esc(x.name)}</span>`).join("");
    const title = esc(T("sng_of", "{host}'s Sit & Go", { host: r.host }));
    return `<article class="tcard sng${reg ? "" : " past"}" aria-label="${title}">` +
      `<div class="tcard-h"><span class="ic" aria-hidden="true">🏁</span><div><b>${title}</b>` +
      `<small>${esc(T("sng_seats_n", "{n} seats", { n: r.size }))}${r.turbo ? " · " + esc(T("sng_turbo_tag", "Turbo")) : ""} · ${sngState(r)}</small></div></div>` +
      `<div class="seatdots" aria-label="${esc(T("sng_reg_n", "{n} of {size} registered", { n, size: r.size }))}">${dots}<span>${fmt(n)}/${fmt(r.size)}</span></div>` +
      `<div class="meta"><span class="tag gold">${esc(T("sng_entry_n", "Entry {buyin} + {fee}", { buyin: fmt(r.buyin), fee: fmt(r.fee) }))}</span>` +
      `<span class="tag">${esc(T("sng_chips_n", "{n} chips", { n: fmt(r.stack) }))}</span><span class="tag">${esc(T("sng_levels_n", "Blinds up every {n} min", { n: r.level_mins }))}</span>${where}` +
      `${r.on_stream ? `<span class="tag red">📺 ${esc(T("on_stream", "On Pepe's stream"))}</span>` : ""}</div>` +
      `<div class="meta sng-prz">${prizeTags(r.prizes)}</div>` +
      `<div class="acts">${act || "<span></span>"}<a class="cz-btn ghost sm" href="${url}">👁 ${esc(T("watch", "Watch"))}</a></div></article>`;
  }
  let sngData = null;
  const sngPick = { buyin: null };
  let sngBusy = false;          // (review) the Create request is out: the lobby poll's sngSheet() keeps the button off (no second sit & go)
  function renderSng(j) {
    const sec = $("cz-sng");
    if (!sec) return;
    const sg = j.sng || null;
    sngData = sg;
    const list = sg ? sg.list || [] : [];
    sec.hidden = !sg || (!sg.on && !list.length) || lobbyTab === "bj" || lobbyTab === "roulette";
    if (sec.hidden) return;
    // (review: Register / Create / "Create one" only for who may enter - can_create; staff only: a member watches)
    const html = list.length ? list.map((r) => sngCard(r, sg)).join("")
      : `<div class="lob-empty">${esc(sg.can_create ? T("sng_none", "No Sit & Go is open right now. Create one and others can join you.")
                                                      : T("sng_none_view", "No Sit & Go is open right now."))}</div>`;
    if ($("cz-sngs").dataset.v !== html) { $("cz-sngs").dataset.v = html; $("cz-sngs").innerHTML = html; tickSng(); }
    const note = $("cz-sng-note");
    if (note.dataset.def === undefined) note.dataset.def = note.textContent;
    note.textContent = sg.audience === "staff" ? T("sng_staff_only", "Sit & Gos are open to staff only for now.") : note.dataset.def;
    $("cz-sng-open").hidden = !(signed && sg.can_create);
    if ($("cz-sngnew").open) sngSheet();
  }
  function sngSheet() {
    const sg = sngData;
    if (!sg) return;
    if (!sngPick.buyin || !sg.buyins.includes(sngPick.buyin)) sngPick.buyin = sg.buyins[0];
    const box = $("cz-sng-buyins");
    const sig = sg.buyins.join() + "|" + sngPick.buyin;
    if (box.dataset.v !== sig) {
      box.dataset.v = sig;
      box.innerHTML = sg.buyins.map((b) => `<button type="button" data-b="${b}" aria-pressed="${b === sngPick.buyin}">${esc(fmt(b))}</button>`).join("");
    }
    const size = Number($("cz-sng-size").value) || 6;
    const at = $("cz-sng-at");
    const opts = Array.from({ length: Math.max(0, size - 2) }, (_, i) => i + 2);
    const want = opts.join();
    if (at.dataset.v !== want) {
      const keep = at.value;
      at.dataset.v = want;
      at.innerHTML = `<option value="">${esc(T("sng_when_full", "When it's full"))}</option>` +
        opts.map((k) => `<option value="${k}">${esc(T("sng_at_opt", "At {n} players (a {s} s countdown)", { n: k, s: sg.countdown_secs }))}</option>`).join("");
      if (opts.map(String).includes(keep)) at.value = keep;
    }
    $("cz-sng-turbo-l").textContent = T("sng_turbo_lbl", "Turbo: blinds up every {n} min", { n: sg.turbo_mins });
    const turbo = $("cz-sng-turbo").checked;
    const fee = Math.floor((sngPick.buyin * sg.fee_pct) / 100);
    const band = sg.payouts[size <= 3 ? 0 : size <= 6 ? 1 : 2] || [100];
    const pool = sngPick.buyin * size;
    const prizes = band.map((p) => Math.floor((pool * p) / 100));
    prizes[0] += pool - prizes.reduce((a, b) => a + b, 0);
    $("cz-sng-sum").textContent = T("sng_sum", "Entry {entry} PAT ({buyin} + a {fee} fee to the House) · {stack} tournament chips · blinds up every {mins} min · prizes if full: {prizes} PAT",
      { entry: fmt(sngPick.buyin + fee), buyin: fmt(sngPick.buyin), fee: fmt(fee), stack: fmt(sg.stack), mins: turbo ? sg.turbo_mins : sg.level_mins,
        prizes: prizes.map((p, i) => medal(i) + " " + fmt(p)).join(" · ") });
    const bal = lobbyData && lobbyData.me ? lobbyData.me.balance : null;
    const go = $("cz-sng-go");
    const poor = bal != null && bal < sngPick.buyin + fee;
    go.disabled = sngBusy || poor;
    go.textContent = poor ? T("not_enough", "not enough PAT") : T("sng_create_n", "Create and register · {n} PAT", { n: fmt(sngPick.buyin + fee) });
  }
  function wireSng() {
    if (!$("cz-sng")) return;
    const anchor = $("cz-open-wrap");                   // (the section sits after the lobby's tables, before "Open a table")
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore($("cz-sng"), anchor);
    $("cz-sng-open").addEventListener("click", () => { sngSheet(); openSheet("cz-sngnew"); });
    for (const id of ["cz-sng-size", "cz-sng-turbo", "cz-sng-at"]) $(id).addEventListener("change", sngSheet);
    $("cz-sng-buyins").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-b]");
      if (!b) return;
      sngPick.buyin = Number(b.dataset.b);
      sngSheet();
    });
    $("cz-sng-go").addEventListener("click", async () => {
      const go = $("cz-sng-go");
      if (go.disabled || sngBusy) return;
      sngBusy = true;
      go.disabled = true;
      const at = $("cz-sng-at").value;
      let j = {};
      try {
        j = await post("/api/casino/sng/new", { size: Number($("cz-sng-size").value), buyin: sngPick.buyin, turbo: $("cz-sng-turbo").checked,
                                               start_at: at ? Number(at) : null, idem: idem() });
      } catch (e) { j = {}; } finally { sngBusy = false; }
      sngSheet();
      if (j.ok && j.table) location.href = "/casino/holdem/t/" + encodeURIComponent(j.table);
      else toast(j.reply || j.error || T("sng_create_fail", "Couldn't create the Sit & Go."), true);
    });
    $("cz-sngs").addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-sngact]");
      if (!b || b.disabled) return;
      b.disabled = true;
      const j = await post(`/api/casino/sng/${encodeURIComponent(b.dataset.id)}/${b.dataset.sngact}`, { idem: idem() });
      b.disabled = false;
      toast(j.reply || j.error || (j.ok ? "" : T("act_fail", "That didn't work.")), !j.ok);
      lobby();
    });
  }
  async function lobby() {
    try {
      // 1.99aoj (contract 3): ?rl=1 - this script draws a wheel's row as a wheel card (an older page gets none); `now` = the
      // server's clock for the wheels' countdowns
      lobbyData = await (await fetch("/api/casino/lobby?rl=1", { credentials: "same-origin" })).json();
      if (lobbyData && lobbyData.now) setSkew(lobbyData.now);
      renderLobby();
    } catch (e) { toast(T("lobby_fail", "Couldn't load the tables."), true); }
  }
  /** g: "bj" | "holdem" | "roulette"; high: a 💎 High Roller table / wheel */
  const OPEN_BTN = { bj: ["cz-open-bj-go", "cz-open-hrbj-go"], holdem: ["cz-open-hm-go", "cz-open-hrhm-go"], roulette: ["cz-open-rl-go", "cz-open-hrrl-go"] };
  async function openTable(g, high) {
    const btn = $(OPEN_BTN[g][high ? 1 : 0]);
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    // 1.99aoj (D1, contract 4): {game: "roulette", hr?} opens a web wheel the viewer hosts (one at a time; 💎 for High Rollers) -
    // the server answers 200 {ok, table} or 409 with the reason (already hosting one, the High Roller role, the casino full)
    const body = { game: g === "holdem" ? "holdem" : g === "roulette" ? "roulette" : "bj", idem: idem() };
    if (g === "holdem") body.blinds = high ? hrBlinds : blinds;
    else if (high) body.hr = true;
    // 1.99amf h20: the picked theme, for a game it's drawn for (the server checks the switch and the viewer again); a wheel opens classic
    const th = lobbyData && lobbyData.themes && lobbyData.themes.pick ? (lobbyData.themes.list || []).find((x) => x.id === lobbyTheme) : null;
    if (g !== "roulette" && th && !th.default && th.games.includes(g === "holdem" ? "holdem" : "bj")) body.theme = th.id;
    let j = {};
    try { j = await post("/api/casino/open", body); } catch (e) { j = {}; } finally { btn.disabled = false; }
    if (j.ok && j.table) {
      location.href = g === "roulette" ? "/casino/roulette/t/" + encodeURIComponent(j.table)
                    : (g === "holdem" ? "/casino/holdem/t/" : "/casino/blackjack/t/") + j.table + (g === "holdem" ? "?sit=1" : "#bet");
    } else if (g === "roulette" && j.table && typeof j.table === "string") {
      // (review) "You already have a roulette wheel open" is the one refusal that names a wheel (j.table, your web wheel): go to it - its
      // 🎛️ Host Tools close it. A retry after a lost answer lands here too, on the wheel the first try opened.
      toast(j.reply || j.error || T("rl_open_fail", "Couldn't open a wheel."), true);
      location.href = "/casino/roulette/t/" + encodeURIComponent(j.table);
    } else toast(j.reply || j.error || (g === "roulette" ? T("rl_open_fail", "Couldn't open a wheel.") : T("open_fail", "Couldn't open a table.")), true);
  }
  /** 1.99aoj: #all / #bj / #holdem / #roulette picks the lobby's tab (the page's own game when none); a tab you pick is
   *  written back (replaceState: no history entry), so Back from a table lands on the same tab */
  function hashTab() {
    const h = String((typeof location !== "undefined" && location.hash) || "").replace(/^#/, "").toLowerCase();
    return TABS.includes(h) ? h : null;
  }
  function writeTab() {
    try {
      if (typeof history === "undefined" || !history.replaceState) return;
      const cur = hashTab();
      if (lobbyTab === game ? !cur : cur === lobbyTab) return;
      history.replaceState(history.state, "", lobbyTab === game ? location.pathname + location.search : "#" + lobbyTab);
      if (typeof window.patvNavMark === "function") window.patvNavMark();   // (1.99aoj review: the navbar marks the tab's own link - layout.ejs)
    } catch (e) { /* (a sandboxed frame) */ }
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
    lobbyTab = hashTab() || game;               // (1.99aoj: #roulette - the roulette tab once the lobby says roulette is open to you)
    for (const b of document.querySelectorAll(".lob-tabs button")) {
      b.addEventListener("click", () => { lobbyTab = b.dataset.tab; writeTab(); renderLobby(); });
    }
    // (1.99aoj review: a #tab followed from the navbar - the page doesn't reload - picks the tab and brings the tab strip into view)
    if (window.addEventListener) window.addEventListener("hashchange", () => {
      const h = hashTab();
      if (!h || h === lobbyTab) return;
      lobbyTab = h;
      renderLobby();
      const strip = document.querySelector(".lob-tabs");
      if (strip && typeof strip.scrollIntoView === "function") { try { strip.scrollIntoView({ block: "nearest" }); } catch (e) { /* (an old engine) */ } }
    });
    pickBlinds($("cz-blinds"), (v) => { blinds = v; });
    pickBlinds($("cz-hrblinds"), (v) => { hrBlinds = v; });
    if ($("cz-themes")) $("cz-themes").addEventListener("click", (e) => { const b = e.target.closest("button[data-th]"); if (b) { lobbyTheme = b.dataset.th; renderLobby(); } });
    $("cz-open-bj-go").addEventListener("click", () => openTable("bj"));
    $("cz-open-hm-go").addEventListener("click", () => openTable("holdem"));
    $("cz-open-hrbj-go").addEventListener("click", () => openTable("bj", true));
    $("cz-open-hrhm-go").addEventListener("click", () => openTable("holdem", true));
    if ($("cz-open-rl-go")) $("cz-open-rl-go").addEventListener("click", () => openTable("roulette"));
    if ($("cz-open-hrrl-go")) $("cz-open-hrrl-go").addEventListener("click", () => openTable("roulette", true));
    wireSng();                                                // h22
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
      if (f.emoji) { const e = document.createElement("span"); e.className = "ufl-e"; e.textContent = f.emoji; e.dataset.e = f.emoji; fl.appendChild(e); }
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
    if (p.veil) { veilMenu(anchor, p, seat); return; }
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
  /** a small menu at anchor: o = {cls, aria, avatar: {name, avatar?, veil?}, name, role, items: [[label, href, fn, why, danger]], note} */
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
    if ((o.items || []).length) { list.setAttribute("role", "menu"); list.setAttribute("aria-label", o.aria); }    // (a masked seat's: only Block / Unblock, signed in - casmask)
    for (const [label, href, fn, why, danger] of o.items || []) {
      const b = document.createElement(href ? "a" : "button"); b.className = "pm-pop-i" + (danger ? " danger" : ""); b.setAttribute("role", "menuitem"); b.tabIndex = -1;
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
    // 1.99aoj: at a wheel Pepe is the croupier and the history is spins, not hands
    items.push(["📜 " + (game === "roulette" ? T("rl_pepe_history", "Spin history") : T("pepe_history", "Hand history")), null, () => { const h = $("cz-histbtn"); if (h) h.click(); }]);
    if (t.on_stream && pe.pad) items.push(["📺 " + T("pepe_stream", "On Pepe's stream"), pe.pad]);
    smallMenu(anchor, { cls: "cz-pepe", aria: T("pepe_menu", "Pepe"), avatar: { name: "Pepe", avatar: "/public/img/pepe.png" }, name: "Pepe",
                        role: game === "roulette" ? T("rl_pepe_role", "the croupier · provably fair") : T("pepe_role", "the dealer · provably fair"), items });
  }
  /** a masked seat's menu: its label and that they play incognito - no profile, no tip, nothing that says who. 1.99akb casmask (the
   *  1.99ajw verifier's gap b): 🚫 Block… - a FROG-NAME block, the chat's masked-entry item and sheet (block-sheet.js veil: whatever frog
   *  name they use their veiled activity is hidden from you; the server finds who it is from the masked seat's own id and never says) -
   *  or ✅ Unblock on a frog name you already blocked that way (the people answer's vb). Signed-out viewers never get this menu.
   *  casmask review: a FROG-NAMED seat only (the people answer's bk) - a "someone" seat can be the one you just saw named; Block in
   *  the danger colour, as the chat's masked-entry menu has it. */
  function veilMenu(anchor, p, seat) {
    const name = String(p.display || "someone");
    const items = [];
    const bt = (k, d) => (window.__t ? window.__t(k, d) : d);       // (the chat menu's own words - room-mod.js)
    if (signed && seat && p.bk && window.PATVBlockSheet) {
      const on = !p.vb;
      items.push([on ? "🚫 " + bt("js.block.menu", "Block…") : "✅ " + bt("js.block.menu_un", "Unblock"), null, () => {
        window.PATVBlockSheet.open({ ref: { k: "cseat", t: tableId, s: String(seat) }, name, veil: true, on, anchor,
                                     onDone: () => { ppl.at = 0; loadPeople(); } });
      }, null, on]);
    }
    smallMenu(anchor, { cls: "cz-veilm", aria: T("veil_menu", "Incognito player {name}", { name }), avatar: { name, veil: 1 }, name,
                        role: T("veil_role", "incognito player"), items,
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

  /** (review) where a closed player's or room's wheel sends you back to: #cb's data-lobby - the lobby's 🛞 tab on the page the casino's
   *  front end uses (e.g. /casino/blackjack#roulette; views/casino-rl.ejs) - else Pepe's lobby wheel (/casino/roulette), as before */
  function rlLobby() {
    const p = String(root.dataset.lobby || "");
    return /^\/(?!\/)[\w\-/]*(?:#roulette)?$/.test(p) ? p : "/casino/roulette";
  }
  /** the table loop: poll the table's state about once a second (slower in a background tab); render() draws it.
   *  opts.first: a query string for the first request only (1.99aof: the wheel's "?notice=1" - its one-time notice) */
  function startTable(render, opts) {
    $("cz-table").hidden = false;
    let stopped = false, running = null, again = null, timer = null, lastD = null, first = (opts && opts.first) || "";
    // 1.99aof (UI-14): a refresh asked for while one is out (a move's "show me now") runs once more after it, so it resolves on a
    // state from after the call - a stale answer never repaints a just-placed chip away
    function refresh() {
      if (running) {
        if (!again) again = running.then(() => { again = null; return refresh(); });
        return again;
      }
      running = load().finally(() => { running = null; });
      return running;
    }
    async function load() {
      try {
        const q = first;
        first = "";
        const r = await fetch(`/api/casino/t/${tableId}${q}`, { credentials: "same-origin" });
        if (r.status === 404) {
          // 1.99aof (ENGINE-4): a rotated lobby wheel that has left memory - the lobby page opens the current one
          if (game === "roulette" && lastD && lastD.table && lastD.table.lobby) { stopped = true; location.replace("/casino/roulette"); return; }
          const gone = game === "roulette" ? T("rl_closed", "This wheel has closed.") : T("closed", "That table has closed.");   // (1.99aoj review)
          toast(gone, true);
          stopped = true;
          const dock = $("cz-dock");
          if (dock) dock.hidden = true;
          const m = $("cz-msg");
          if (m) m.innerHTML = `${esc(gone)}<small><a href="${esc(game === "roulette" ? rlLobby() : game === "holdem" ? "/casino/holdem" : "/casino/blackjack")}">${esc(T("back_lobby", "Back to the lobby"))}</a></small>`;
          return;
        }
        const d = await r.json();
        if (!d.ok) return;
        lastD = d;
        setSkew(d.now);
        peopleSync(d);                 // 1.99ajw casino2 (before render: a seat drawn now knows whether it is a button)
        render(d);
        hostTools(d);
        fairness(d.table);
        balance(d.me ? d.me.balance : null);
        watching(d.watching);
      } catch (e) { /* the next tick tries again */ }
    }
    // (h22 phase 2: a scheduled tournament's table polls every 2 s while it isn't your turn - many players poll the same tables)
    const slow = () => !!(lastD && lastD.table && lastD.table.tourney && lastD.table.tourney.kind === "mtt" && !(lastD.me && lastD.me.my_turn));
    const loop = () => { clearTimeout(timer); if (!stopped) timer = setTimeout(async () => { await refresh(); loop(); }, document.hidden ? 5000 : slow() ? 2000 : 1000); };
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

  window.CZ = { $, T, esc, fmt, reduced, idem, post, toast, note, announce, drawCards, staticCards, cardLabel, chipCls, stackHTML, pileHTML, short, avatarHTML, ringSVG, theme,
                armClock, totalFor, pop, net, openSheet, closeSheet, loadHistory, wireHost, startTable, startLobby, actor, streetName, game, tableId, signed,
                skew: () => skew,
                // 1.99ajw casino2: the person menu (seatWho wraps a seat's avatar + plate), the table's pads / people (casino-chat.js)
                seatWho, personMenu, pepeMenu, people: () => ppl.d, loadPeople, view: () => lastView, me: meName,
                sng: { mmss, medal, prizeTags, tick: tickSng } };          // (h22: the table page's Sit & Go header - casinohm.js)
})();
