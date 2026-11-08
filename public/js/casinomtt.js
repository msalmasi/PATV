// casinomtt.js — 🏆 scheduled multi-table tournaments on the web (hand-off 22 phase 2, 1.99??; casino/mtt.js): the Hold'em lobby's
// Tournaments block (#cz-mtt, above the Sit & Go section, from GET /api/casino/mtt), the tournament page (/casino/holdem/mtt/<id>: the
// header, the Info / Players / Tables / Prizes / Results tabs, Register / Unregister / Re-enter / Remind me), the leaderboard
// (/casino/holdem/leaderboard) and the header of a tournament TABLE (casinohm.js asks window.CZMTT.tableHead when table.tourney.kind is
// "mtt": tournament + table number, players left, average stack, your rank, the next level, holds, the move to another table, results).
// Strings: T("mtt_*", English) -> js.casino.mtt_* (the defaults equal locales/en.json). Every POST: JSON + X-Requested-With: fetch + an idem.
(function () {
  "use strict";
  const T = (k, d, v) => (window.__t ? window.__t("js.casino." + k, d, v) : String(d).replace(/\{!?(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : m)));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lang = document.documentElement.lang || "en";
  const fmt = (n) => { try { return Math.trunc(Number(n) || 0).toLocaleString(lang); } catch (e) { return String(Math.trunc(Number(n) || 0)); } };
  const $ = (id) => document.getElementById(id);
  const idem = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  let skew = 0;
  // the server's clock: the table page's (casino-ui.js CZ.skew), else what our own answers said
  const now = () => Date.now() - (window.CZ && window.CZ.tableId && window.CZ.skew ? window.CZ.skew() : skew);
  async function post(url, body) {
    const r = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, body: JSON.stringify(body) });
    try { return await r.json(); } catch (e) { return { ok: false }; }
  }
  function toast(text, bad) {
    if (window.CZ && window.CZ.toast) return window.CZ.toast(text, bad);
    const el = $("mtt-toast");
    if (!el) return;
    el.textContent = text || "";
    el.className = "cz-toast" + (bad ? " bad" : "");
    setTimeout(() => { el.textContent = ""; }, bad ? 7000 : 4000);
  }
  const when = (ms) => { try { return new Date(ms).toLocaleString(lang, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return new Date(ms).toISOString(); } };
  const inText = (ms) => {
    const d = Math.round((ms - now()) / 60000);
    if (d <= 0) return T("mtt_now", "now");
    if (d < 60) return T("mtt_in_min", "in {n} min", { n: d });
    const h = Math.round(d / 60);
    return h < 48 ? T("mtt_in_h", "in {n} h", { n: h }) : T("mtt_in_d", "in {n} days", { n: Math.round(h / 24) });
  };
  const lenText = (ms) => { const m = Math.round(ms / 60000); return m < 90 ? T("mtt_len_min", "about {n} min", { n: m }) : T("mtt_len_h", "about {n} h", { n: Math.round(m / 6) / 10 }); };
  const mmss = (ms) => { const n = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0"); };
  function tickClocks() { for (const el of document.querySelectorAll("[data-mttdl]")) el.textContent = mmss(Number(el.dataset.mttdl) - now()); }
  setInterval(tickClocks, 1000);
  const clockHTML = (dl) => (dl ? `<b data-mttdl="${Number(dl)}">${esc(mmss(Number(dl) - now()))}</b>` : "—");
  const buyinText = (r) => (r.freeroll ? T("mtt_freeroll", "Freeroll") : T("mtt_buyin_n", "{buyin} + {fee} PAT", { buyin: fmt(r.buyin), fee: fmt(r.fee) }));
  const statusText = (s) => ({ scheduled: T("mtt_st_scheduled", "Scheduled"), registering: T("mtt_st_registering", "Registering"), running: T("mtt_st_running", "Running"),
                               finishing: T("mtt_st_finishing", "Paying out"), settled: T("mtt_st_settled", "Paying out"), done: T("mtt_st_done", "Finished"),
                               cancelled: T("mtt_st_cancelled", "Cancelled") }[s] || s);
  const structText = (s) => [s.kind === "turbo" ? T("mtt_turbo", "Turbo") : T("mtt_standard", "Standard"), T("mtt_chips_n", "{n} chips", { n: fmt(s.start_chips) }),
                             T("mtt_level_mins_n", "{n}-min levels", { n: s.level_mins }), s.reentry_max ? T("mtt_reentry_n", "re-entry x{n}", { n: s.reentry_max }) : ""].filter(Boolean).join(" · ");
  const medal = (i) => ["🥇", "🥈", "🥉"][i] || "#" + (i + 1);

  // ── the lobby block ──
  function card(r, j) {
    const signed = !!(document.getElementById("cb") && document.getElementById("cb").dataset.signed);
    const mine = !!r.me;
    const acts = [];
    if (r.status === "registering" || (r.status === "running" && r.late_open)) {
      if (mine) acts.push(r.status === "registering" ? `<button type="button" class="cz-btn ghost sm" data-mttact="unregister" data-id="${esc(r.id)}">${esc(T("mtt_unregister", "Unregister"))}</button>` : "");
      else if (signed && j.can_register) acts.push(`<button type="button" class="cz-btn gold sm" data-mttact="register" data-id="${esc(r.id)}">${esc(r.status === "running" ? T("mtt_late_register", "Late register") : T("mtt_register", "Register"))}</button>`);
    }
    if (signed && !mine && (r.status === "scheduled" || r.status === "registering")) acts.push(`<button type="button" class="cz-btn ghost sm" data-mttact="remind" data-id="${esc(r.id)}">🔔 ${esc(T("mtt_remind", "Remind me"))}</button>`);
    if (mine && r.status === "running") acts.push(`<a class="cz-btn gold sm" href="${esc(r.url)}">${esc(T("mtt_my_table", "Take me to my table"))}</a>`);
    if (r.final_table) acts.push(`<a class="cz-btn ghost sm" href="/casino/holdem/t/${esc(r.final_table)}">📺 ${esc(T("mtt_watch_final", "Watch the final table"))}</a>`);
    acts.push(`<a class="cz-btn ghost sm" href="${esc(r.url)}">${esc(T("mtt_details", "Details"))}</a>`);
    const startLine = r.status === "running" ? (r.late_open ? T("mtt_late_until", "Late reg until level {n}", { n: r.structure.late_levels }) : T("mtt_level_left", "Level {n} · {left} left", { n: r.level, left: fmt(r.players_left) }))
      : `${esc(when(r.start_at))} · ${esc(inText(r.start_at))}`;
    return `<article class="tcard mtt${mine ? " mine" : ""}" aria-label="${esc("#" + r.no + " " + r.title)}">` +
      `<div class="mtt-top"><b class="mtt-title">#${esc(r.no)} ${esc(r.title)}</b><span class="tag mtt-st ${esc(r.status)}">${esc(statusText(r.status))}</span></div>` +
      `<small class="mtt-when">${r.status === "running" ? esc(startLine) : startLine} · ${esc(lenText(r.est_ms))}</small>` +
      `<div class="meta"><span class="tag gold">${esc(buyinText(r))}</span>${r.guarantee ? `<span class="tag mtt-gtd">🛡 ${esc(T("mtt_gtd_n", "{n} PAT guaranteed", { n: fmt(r.guarantee) }))}</span>` : ""}` +
      `<span class="tag">${esc(T("mtt_reg_n", "{n}/{max} registered", { n: fmt(r.status === "running" ? r.entries : r.registered), max: fmt(r.max_entries) }))}</span></div>` +
      `<small class="mtt-struct">${esc(structText(r.structure))}</small>` +
      `<div class="mtt-acts">${acts.filter(Boolean).join("")}</div></article>`;
  }
  let lobTab = "list";
  function renderLobby(j) {
    const sec = $("cz-mtt");
    if (!sec) return;
    const rows = [].concat(j.running || [], j.registering || [], j.upcoming || []);
    sec.hidden = !j.mtt_on && !rows.length;
    if (sec.hidden) return;
    $("cz-mtt-note").textContent = j.audience === "staff" ? T("mtt_staff_only", "Tournaments are open to staff only for now.") : $("cz-mtt-note").dataset.def;
    for (const b of sec.querySelectorAll(".mtt-tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === lobTab));
    $("cz-mtts").hidden = lobTab !== "list";
    $("cz-mtt-board").hidden = lobTab !== "board";
    if (lobTab === "board") return board($("cz-mtt-board"), "all", 1);
    const html = rows.length ? rows.map((r) => card(r, j)).join("") : `<div class="lob-empty">${esc(T("mtt_none", "No tournaments scheduled - check back soon."))}</div>`;
    const recent = (j.recent || []).slice(0, 5);
    const rec = recent.length ? `<h3 class="mtt-recent-h">${esc(T("mtt_recent", "Recent results"))}</h3><ul class="mtt-recent">` +
      recent.map((r) => `<li><a href="${esc(r.url)}">#${esc(r.no)} ${esc(r.title)}</a> <small>${esc(when(r.start_at))}</small></li>`).join("") + "</ul>" : "";
    if ($("cz-mtts").dataset.v !== html + rec) { $("cz-mtts").dataset.v = html + rec; $("cz-mtts").innerHTML = html + rec; }
  }
  async function lobby() {
    try {
      const j = await (await fetch("/api/casino/mtt", { credentials: "same-origin" })).json();
      if (j && j.now) skew = Date.now() - j.now;
      if (j && j.ok) renderLobby(j);
    } catch (e) { /* the next poll tries again */ }
  }
  function wireLobby() {
    const sec = $("cz-mtt");
    if (!sec) return;
    const sng = $("cz-sng");
    const anchor = sng || $("cz-open-wrap");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(sec, anchor);       // above the Sit & Go section
    $("cz-mtt-note").dataset.def = $("cz-mtt-note").textContent;
    sec.addEventListener("click", async (e) => {
      const tab = e.target.closest(".mtt-tabs button");
      if (tab) { lobTab = tab.dataset.tab; return lobby(); }
      const b = e.target.closest("button[data-mttact]");
      if (!b || b.disabled) return;
      b.disabled = true;
      const what = b.dataset.mttact;
      const j = await post(`/api/casino/mtt/${encodeURIComponent(b.dataset.id)}/${what}`, what === "remind" ? { idem: idem(), on: true } : { idem: idem() });
      b.disabled = false;
      toast(j.reply || j.error || (j.ok ? "" : T("mtt_fail", "That didn't work.")), !j.ok);
      lobby();
    });
    lobby();
    setInterval(() => { if (!document.hidden) lobby(); }, 10000);
  }

  // ── the leaderboard ──
  async function board(box, period, page) {
    if (!box) return;
    try {
      const j = await (await fetch(`/api/casino/mtt/leaderboard?period=${encodeURIComponent(period)}&page=${page}`, { credentials: "same-origin" })).json();
      if (!j.ok) throw new Error("board");
      const rows = j.rows || [];
      const html = `<div class="mtt-board-h"><b>🏅 ${esc(T("mtt_board", "Leaderboard"))}</b> <small>${esc(period === "all" ? T("mtt_all_time", "All time") : period)}</small></div>` +
        (rows.length ? `<ol class="mtt-board">${rows.map((r) => `<li><span class="rk">${esc(r.rank)}</span><span class="nm">${esc(r.name)}</span><b>${esc(fmt(r.points))}</b>` +
          `<small>${esc(T("mtt_wins_cashes", "{w} wins · {c} cashes", { w: r.wins, c: r.cashes }))}</small></li>`).join("")}</ol>`
          : `<div class="lob-empty">${esc(T("mtt_board_empty", "No finishes yet."))}</div>`) +
        (j.my_veiled_points ? `<p class="fine">${esc(T("mtt_veiled_pts", "{n} points from veiled play are not on the public board.", { n: fmt(j.my_veiled_points) }))}</p>` : "");
      box.innerHTML = html;
    } catch (e) { box.innerHTML = `<div class="lob-empty">${esc(T("mtt_board_fail", "Couldn't load the leaderboard."))}</div>`; }
  }

  // ── the tournament page ──
  let page = null, tab = "info", playersPage = 1;
  function head(m, me) {
    const stats = (label, val) => `<div class="mtt-stat"><small>${esc(label)}</small><b>${val}</b></div>`;
    const running = m.status === "running";
    const banners = [];
    if (m.paused) banners.push(`<div class="mtt-banner pause">⏸ ${esc(m.pause_why === "system" ? T("mtt_paused_sys", "Paused - the tables are being checked.") : T("mtt_paused", "Paused by an admin."))}</div>`);
    if (m.h4h) banners.push(`<div class="mtt-banner h4h">🫧 ${esc(T("mtt_h4h", "Hand-for-hand: every table plays one hand at a time until someone is out."))}${m.h4h_waiting && m.h4h_waiting.length ? " " + esc(T("mtt_h4h_wait", "Waiting for table {n}.", { n: m.h4h_waiting[0] })) : ""}</div>`);
    if (m.cancelled) banners.push(`<div class="mtt-banner off">🛑 ${esc(T("mtt_cancelled_b", "Cancelled ({why}) - every entry was refunded in full.", { why: m.cancelled }))}</div>`);
    let html = `<div class="mtt-head-top"><h1>🏆 #${esc(m.no)} ${esc(m.title)}</h1><span class="tag mtt-st ${esc(m.status)}">${esc(statusText(m.status))}</span></div>` +
      `<p class="mtt-sub">${esc(when(m.start_at))} · ${esc(buyinText(m))}${m.guarantee ? " · 🛡 " + esc(T("mtt_gtd_n", "{n} PAT guaranteed", { n: fmt(m.guarantee) })) : ""} · ${esc(structText(m.structure))}</p>` + banners.join("");
    html += '<div class="mtt-stats">' + (running || m.status === "finishing"
      ? stats(T("mtt_level", "Level"), esc(m.level)) + stats(T("mtt_blinds", "Blinds"), `${esc(fmt(m.sb))}/${esc(fmt(m.bb))}`) +
        stats(T("mtt_next_level", "Next level"), m.next_level_at ? clockHTML(m.next_level_at) + ` <small>${esc(fmt(m.next_sb))}/${esc(fmt(m.next_bb))}</small>` : "—") +
        stats(T("mtt_left", "Players left"), `${esc(fmt(m.players_left))}/${esc(fmt(m.entries))}`) + stats(T("mtt_avg", "Average stack"), esc(fmt(m.avg_stack))) +
        stats(T("mtt_pool", "Prize pool"), esc(fmt(m.prize_pool)) + " PAT") + stats(T("mtt_paid", "Paid places"), esc(m.paid))
      : stats(T("mtt_registered", "Registered"), `${esc(fmt(m.registered))}/${esc(fmt(m.max_entries))}`) + stats(T("mtt_starts", "Starts"), esc(inText(m.start_at))) +
        stats(T("mtt_length", "Length"), esc(lenText(m.est_ms))) + stats(T("mtt_pool", "Prize pool"), esc(fmt(m.prize_pool)) + " PAT")) + "</div>";
    const acts = [];
    if (me) {
      if (me.registered && m.status === "registering") acts.push(`<button type="button" class="cz-btn ghost sm" data-pg="unregister">${esc(T("mtt_unregister", "Unregister"))}</button>`);
      if (me.can_register) acts.push(`<button type="button" class="cz-btn gold sm" data-pg="register">${esc(T("mtt_register_n", "Register · {n}", { n: buyinText(m) }))}</button>`);
      if (me.can_reenter) acts.push(`<button type="button" class="cz-btn gold sm" data-pg="register">${esc(T("mtt_reenter_n", "Re-enter · {n}", { n: buyinText(m) }))}</button>`);
      if (me.table_id) acts.push(`<a class="cz-btn gold sm" href="/casino/holdem/t/${esc(me.table_id)}">${esc(T("mtt_my_table_n", "Take me to my table (table {n})", { n: me.table_no }))}</a>`);
      if (!me.registered || m.status === "registering") acts.push(`<button type="button" class="cz-btn ghost sm" data-pg="remind" data-on="${me.remind ? "0" : "1"}" aria-pressed="${!!me.remind}">🔔 ${esc(me.remind ? T("mtt_remind_off", "Reminder on") : T("mtt_remind", "Remind me"))}</button>`);
      if (me.telegram_linked && me.telegram_tourney === false && (m.status === "registering" || m.status === "scheduled")) acts.push(`<label class="mtt-tg"><input type="checkbox" id="mtt-tg"> ${esc(T("mtt_tg", "also on Telegram"))}</label>`);
      if (me.stack != null) acts.push(`<span class="mtt-me">${esc(T("mtt_me_line", "Your stack {s} · rank {r}", { s: fmt(me.stack), r: me.rank || "—" }))}</span>`);
      if (me.place) acts.push(`<span class="mtt-me">${esc(T("mtt_me_place", "You finished {p}", { p: "#" + me.place }))}${me.prize ? " · " + esc(fmt(me.prize)) + " PAT" : ""}</span>`);
    } else if (m.status === "registering") acts.push(`<a class="cz-btn ghost sm" href="/login">${esc(T("mtt_signin", "Sign in to register"))}</a>`);
    if (acts.length) html += `<div class="mtt-acts">${acts.join("")}</div>`;
    return html;
  }
  function info(m) {
    const s = m.structure;
    const rows = s.levels.slice(0, Math.max(12, m.level + 4)).map((l, i) => `<tr${i + 1 === m.level ? ' class="cur"' : ""}><td>${i + 1}</td><td>${esc(fmt(l[0]))}/${esc(fmt(l[1]))}</td><td>${esc(s.level_mins)}</td>` +
      `<td>${i < s.late_levels ? "✓" : ""}</td></tr>`).join("");
    return `<div class="mtt-rules"><p>${esc(T("mtt_rule_paid", "Prizes are paid when the tournament ends."))} ${esc(T("mtt_rule_sitout", "You are never stood up - sitting out only blinds you away."))}</p>` +
      `<p>${esc(s.late_levels ? T("mtt_rule_late", "Late registration is open for the first {n} levels (a late entrant starts with at least {bb} big blinds).", { n: s.late_levels, bb: s.late_depth_bb }) : T("mtt_rule_nolate", "No late registration."))} ` +
      `${esc(s.reentry_max ? T("mtt_rule_reentry", "Re-entry: up to {n} time(s) while late registration is open.", { n: s.reentry_max }) : T("mtt_rule_noreentry", "No re-entries."))}</p>` +
      `<p class="commit">${esc(T("mtt_commit", "Seating draw commitment"))}: ${esc(m.draw_commit || "—")}${m.seed ? `<br>${esc(T("mtt_seed", "Revealed seed"))}: ${esc(m.seed)}` : ""}</p></div>` +
      `<table class="mtt-levels"><thead><tr><th>${esc(T("mtt_level", "Level"))}</th><th>${esc(T("mtt_blinds", "Blinds"))}</th><th>${esc(T("mtt_mins", "Minutes"))}</th><th>${esc(T("mtt_late", "Late reg"))}</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  function prizes(m) {
    return `<p class="fine">${esc(m.projected ? T("mtt_projected", "Projected for the entries so far - fixed when late registration closes.") : T("mtt_final_prizes", "Fixed at late registration's close."))}</p>` +
      `<ol class="mtt-prizes">${(m.prizes || []).map((p, i) => `<li><span>${esc(medal(i))}</span><b>${esc(fmt(p))} PAT</b></li>`).join("")}</ol>`;
  }
  function results(m, res) {
    if (!res) return `<div class="lob-empty">${esc(T("mtt_no_results", "Results appear when it ends."))}</div>`;
    const ov = m.overlay;
    return (ov && ov.state !== "paid" ? `<p class="fine">${esc(T("mtt_overlay_late", "The guaranteed part ({n} PAT) is delayed.", { n: fmt(ov.amount) }))}</p>` : "") +
      `<ol class="mtt-results">${res.map((r) => `<li><span>${esc(r.place <= 3 ? medal(r.place - 1) : "#" + r.place)} ${esc(r.name)}${r.tied ? ` <small>${esc(T("mtt_tied", "tied on chips"))}</small>` : ""}</span>` +
        `<b>${r.prize || r.overlay ? esc(fmt(r.prize + r.overlay)) + " PAT" : "—"}</b>${r.points ? `<small>${esc(T("mtt_points_n", "{n} points", { n: fmt(r.points) }))}</small>` : ""}</li>`).join("")}</ol>` +
      (m.seed ? `<p class="fine">${esc(T("mtt_verify", "Verify the seating: sha256(seed) is the commitment shown before the start, and the draw is an HMAC-SHA256 shuffle of the sorted entries."))}</p>` : "");
  }
  async function playersTab(m) {
    const j = await (await fetch(`/api/casino/mtt/${encodeURIComponent(m.id)}/players?page=${playersPage}`, { credentials: "same-origin" })).json();
    if (!j.ok) return "";
    return `<ol class="mtt-players">${j.rows.map((r) => `<li><span class="nm">${esc(r.name)}</span><span>${r.status === "playing" || r.status === "held" ? esc(fmt(r.stack)) : r.place ? "#" + esc(r.place) : esc(T("mtt_out", "out"))}</span>` +
      `<small>${r.table_no ? esc(T("mtt_table_n", "Table {n}", { n: r.table_no })) : ""}${r.prize ? " · " + esc(fmt(r.prize)) + " PAT" : ""}</small></li>`).join("")}</ol>` +
      (j.pages > 1 ? `<div class="mtt-pager"><button type="button" class="cz-btn ghost sm" data-pp="-1"${playersPage <= 1 ? " disabled" : ""}>‹</button> ${playersPage}/${j.pages} <button type="button" class="cz-btn ghost sm" data-pp="1"${playersPage >= j.pages ? " disabled" : ""}>›</button></div>` : "");
  }
  async function tablesTab(m) {
    const j = await (await fetch(`/api/casino/mtt/${encodeURIComponent(m.id)}/tables`, { credentials: "same-origin" })).json();
    if (!j.ok || !j.tables.length) return `<div class="lob-empty">${esc(T("mtt_no_tables", "The tables are drawn at the start."))}</div>`;
    return `<div class="mtt-tables">${j.tables.map((t) => `<a class="mtt-tbl${t.final ? " final" : ""}" href="/casino/holdem/t/${esc(t.id)}"><b>${esc(t.final ? "🏆 " + T("mtt_final_table", "Final table") : T("mtt_table_n", "Table {n}", { n: t.no }))}</b>` +
      `<span>${esc(T("mtt_players_n", "{n} players", { n: t.players }))}</span><small>${esc(T("mtt_biggest_n", "Biggest {n}", { n: fmt(t.biggest) }))}${t.in_hand ? " · " + esc(T("mtt_in_hand", "in a hand")) : t.hold === "h4h" ? " · " + esc(T("mtt_hold_h4h", "waiting (hand-for-hand)")) : t.breaking ? " · " + esc(T("mtt_breaking", "breaking")) : ""}</small></a>`).join("")}</div>`;
  }
  async function renderPage() {
    const box = $("mtt-page");
    if (!box) return;
    try {
      const j = await (await fetch(`/api/casino/mtt/${encodeURIComponent(box.dataset.mtt)}`, { credentials: "same-origin" })).json();
      if (!j.ok) { box.innerHTML = `<div class="lob-empty">${esc(j.error || T("mtt_load_fail", "Couldn't load the tournament."))}</div>`; return; }
      skew = Date.now() - (j.now || Date.now());
      page = j;
      const m = j.mtt;
      const h = head(m, j.me);
      if ($("mtt-head").dataset.v !== h) { $("mtt-head").dataset.v = h; $("mtt-head").innerHTML = h; }
      for (const b of document.querySelectorAll("#mtt-tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
      const body = tab === "info" ? info(m) : tab === "prizes" ? prizes(m) : tab === "results" ? results(m, j.results) : tab === "players" ? await playersTab(m) : await tablesTab(m);
      if ($("mtt-body").dataset.v !== body) { $("mtt-body").dataset.v = body; $("mtt-body").innerHTML = body; }
      tickClocks();
    } catch (e) { /* the next poll */ }
  }
  function wirePage() {
    const box = $("mtt-page");
    if (!box) return;
    $("mtt-tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) { tab = b.dataset.tab; $("mtt-body").dataset.v = ""; renderPage(); } });
    box.addEventListener("click", async (e) => {
      const pp = e.target.closest("button[data-pp]");
      if (pp) { playersPage = Math.max(1, playersPage + Number(pp.dataset.pp)); $("mtt-body").dataset.v = ""; return renderPage(); }
      const b = e.target.closest("button[data-pg]");
      if (!b || b.disabled || !page) return;
      b.disabled = true;
      const what = b.dataset.pg;
      const tg = $("mtt-tg");
      const body = what === "remind" ? { idem: idem(), on: b.dataset.on === "1", telegram: tg && tg.checked ? true : undefined } : what === "register" ? { idem: idem(), remind: !!(tg && tg.checked) } : { idem: idem() };
      const j = await post(`/api/casino/mtt/${encodeURIComponent(page.mtt.id)}/${what}`, body);
      b.disabled = false;
      toast(j.reply || j.error || (j.ok ? "" : T("mtt_fail", "That didn't work.")), !j.ok);
      renderPage();
    });
    const loop = () => setTimeout(async () => { if (!document.hidden) await renderPage(); loop(); }, page && ["running", "finishing"].includes(page.mtt.status) ? 3000 : 15000);
    renderPage().then(loop);
  }
  function wireBoard() {
    const box = $("mtt-board");
    if (!box) return;
    const sel = $("mtt-period");
    const go = () => board(box, sel ? sel.value : "all", 1);
    if (sel) sel.addEventListener("change", go);
    go();
  }

  // ── a tournament table's header (casinohm.js -> CZMTT.tableHead) ──
  let movedOnce = false;
  function tableHead(t, me, headEl, resEl) {
    const tn = t.tourney;
    const mt = (me && me.tourney) || {};
    const stat = (label, val) => `<div class="sng-stat"><small>${esc(label)}</small><b>${val}</b></div>`;
    let html = `<div class="sng-top"><a class="sng-badge mtt" href="${esc(tn.url)}">🏆 ${esc(tn.final ? T("mtt_final_table", "Final table") : T("mtt_table_of", "Tournament #{no} · Table {n} of {k}", { no: tn.no, n: tn.table_no, k: tn.tables_left }))}</a>` +
      `<span class="tag">${esc(tn.name)}</span>${tn.guarantee ? `<span class="tag mtt-gtd">🛡 ${esc(fmt(tn.guarantee))}</span>` : ""}</div>`;
    html += '<div class="sng-stats">' + stat(T("mtt_level", "Level"), esc(tn.level)) + stat(T("mtt_blinds", "Blinds"), `${esc(fmt(tn.sb))}/${esc(fmt(tn.bb))}`) +
      stat(T("mtt_next_level", "Next level"), tn.next_level_at ? clockHTML(tn.next_level_at) : "—") + stat(T("mtt_left", "Players left"), `${esc(fmt(tn.players_left))}/${esc(fmt(tn.entries))}`) +
      stat(T("mtt_avg", "Average stack"), esc(fmt(tn.avg_stack))) + (mt.mtt_rank ? stat(T("mtt_rank", "Your rank"), "#" + esc(mt.mtt_rank)) : "") + "</div>";
    const notes = [];
    if (tn.paused) notes.push("⏸ " + T("mtt_paused_t", "Paused - the next hand waits."));
    else if (tn.hold === "h4h" || tn.h4h) notes.push("🫧 " + T("mtt_h4h_t", "Hand-for-hand") + (tn.h4h_waiting_table ? " · " + T("mtt_h4h_wait", "Waiting for table {n}.", { n: tn.h4h_waiting_table }) : ""));
    else if (tn.hold === "wait") notes.push("⏳ " + T("mtt_hold_wait", "Waiting for players to be moved here."));
    else if (tn.hold === "final") notes.push("🏆 " + T("mtt_hold_final", "The final table is forming."));
    else if (tn.hold === "closed") notes.push("🔀 " + T("mtt_hold_closed", "This table is broken - its players are moving."));
    if (tn.dead_sb) notes.push(T("mtt_dead_sb", "dead small blind"));
    if (notes.length) html += `<p class="sng-who mtt-note">${esc(notes.join(" · "))}</p>`;
    if (mt.moved_to && !movedOnce) {
      movedOnce = true;
      toast(T("mtt_moving_n", "You're moving to table {n}", { n: mt.moved_to.no }), false);
      if (mt.moved_to.id) setTimeout(() => location.replace("/casino/holdem/t/" + encodeURIComponent(mt.moved_to.id)), 1500);
    }
    if (headEl.dataset.v !== html) { headEl.dataset.v = html; headEl.innerHTML = html; }
    resEl.hidden = true;
    tickClocks();
  }

  window.CZMTT = { tableHead, board };
  wireLobby();
  wirePage();
  wireBoard();
})();
