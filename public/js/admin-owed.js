// admin-owed.js — /admin/casino/owed (1.99aoj; casino/owed.js, casino/owedweb.js): every casino payout, refund or cash-out kept owed because
// its credit was refused, with its three actions. Retry now (casino admins) posts {table, item, amount, idem}; Pay another account and
// Write off to the House (a Pepe owner) first take a single-use step-up nonce (POST /api/admin/stepup/nonce {for: "casino_owed"}) and send
// the account password with it. Each form keeps one idempotency key until it gets an answer (a double click does it once), and sends the
// amount it showed: the server refuses an item that changed since the page was drawn.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Math.trunc(Number(n) || 0).toLocaleString("en-US");
  const when = (ms) => { if (!ms) return "—"; try { return new Date(ms).toLocaleString(); } catch (e) { return new Date(ms).toISOString(); } };
  const FETCH = { "Content-Type": "application/json", "X-Requested-With": "fetch" };
  const list = $("owedList");
  const owner = list && list.getAttribute("data-owner") === "1";
  const GAME = { bj: "🂠 Blackjack", holdem: "🃏 Hold'em" };
  const OUT = { retry: "Retry", redirect: "Paid to another account", writeoff: "Written off to the House" };
  function idem() {
    const b = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(b);
    return "owed-" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  async function getJson(url) {
    const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    try { return await r.json(); } catch (e) { return { ok: false, error: "HTTP " + r.status }; }
  }
  async function post(url, body) {
    const r = await fetch(url, { method: "POST", credentials: "same-origin", headers: FETCH, body: JSON.stringify(body) });
    let j = {};
    try { j = await r.json(); } catch (e) { j = { ok: false, error: "HTTP " + r.status }; }
    return j;
  }
  function say(text, good) {
    const s = $("owedStatus");
    s.textContent = text || "";
    s.className = "adm-msg" + (text ? (good ? " ok" : " err") : "");
  }
  const member = (m) => (m && m.name ? esc(m.name) : `<i>account missing</i> <code>${esc(m && m.ref)}</code>`);
  function item(x) {
    const ownerOnly = owner ? "" : " disabled title=\"Pepe owners only\"";
    return `<article class="owed-item" data-id="${esc(x.id)}" data-table="${esc(x.table)}" data-amount="${esc(x.amount)}">
      <h3>${fmt(x.amount)} PAT · ${esc(x.what)}</h3>
      <div class="owed-facts">
        <div><b>Game</b>${esc(GAME[x.game] || x.game)}${x.high_stakes ? " 💎" : ""}</div>
        <div><b>Table</b><a href="${esc(x.url)}">${esc(x.table)}</a>${x.closing ? " (waiting to close)" : ""}</div>
        <div><b>Member</b>${member(x.member)}</div>
        <div><b>Owed since</b>${esc(when(x.since))}</div>
        <div><b>Tries</b>${fmt(x.tries)}</div>
        <div><b>Last refusal</b><code>${esc(x.code || "—")}</code></div>
        <div><b>Next automatic try</b>${esc(when(x.next))}</div>
      </div>
      <div class="owed-acts adm-actions">
        <button type="button" data-op="retry">Retry now</button>
        <button type="button" class="ghost" data-open="redirect"${ownerOnly}>Pay another account…</button>
        <button type="button" class="ghost" data-open="writeoff"${ownerOnly}>Write off to the House…</button>
      </div>
      <form class="owed-form adm-form" data-op="redirect" hidden>
        <p class="adm-help" style="grid-column:1/-1;margin:0">Pays ${fmt(x.amount)} PAT to the account you name instead. The original account can never be paid it afterwards.</p>
        <label>Pay to (username)<input name="to" required maxlength="64" autocomplete="off"></label>
        <label>Reason<input name="reason" required minlength="8" maxlength="200" placeholder="why this account gets it"></label>
        <label>Your account password<input name="password" type="password" required maxlength="200" autocomplete="current-password"></label>
        <div class="adm-actions"><button type="submit">Pay ${fmt(x.amount)} PAT</button></div>
      </form>
      <form class="owed-form adm-form" data-op="writeoff" hidden>
        <p class="adm-help" style="grid-column:1/-1;margin:0">Gives ${fmt(x.amount)} PAT back to the House (the casino jackpot). Nothing is burned.</p>
        <label>Reason<input name="reason" required minlength="8" maxlength="200" placeholder="why it goes back to the House"></label>
        <label>Your account password<input name="password" type="password" required maxlength="200" autocomplete="current-password"></label>
        <div class="adm-actions"><button type="submit" class="danger">Write off ${fmt(x.amount)} PAT</button></div>
      </form>
    </article>`;
  }
  function recentRow(r) {
    const to = r.op === "redirect" && r.to ? ` to ${esc(r.to)}` : "";
    const who = r.member ? esc(r.member) : "an account that is gone";
    return `<li><b>${esc(when(r.at))}</b> · ${esc(r.by || "?")} · ${esc(OUT[r.op] || r.op)}${to} · ${fmt(r.amount)} PAT · ${esc(r.what || "")} (${who}, table <code>${esc(r.table || "?")}</code>) · <i>${esc(r.outcome || "")}</i>${r.reason ? " · “" + esc(r.reason) + "”" : ""}</li>`;
  }
  async function load() {
    const d = await getJson("/api/casino/admin/owed");
    if (!d || !d.ok) { list.innerHTML = `<p class="adm-help">${esc((d && d.error) || "Couldn't load the list.")}</p>`; return; }
    $("owedCount").textContent = String(d.items.length);
    $("owedCount").className = "adm-pill" + (d.items.length ? " bad" : " ok");
    list.innerHTML = d.items.length ? d.items.map(item).join("") : `<p class="adm-help">Nothing is owed. Every casino payout, refund and cash-out went through.</p>`;
    $("owedRecentList").innerHTML = (d.recent || []).length ? d.recent.map(recentRow).join("") : "<li>Nothing yet.</li>";
  }
  async function send(art, op, fields, button) {
    if (button.disabled) return;
    const keyOf = "idem" + op;
    art.dataset[keyOf] = art.dataset[keyOf] || idem();          // (one key until an answer comes back: a double submit does it once)
    const body = Object.assign({ table: art.dataset.table, item: art.dataset.id, amount: Number(art.dataset.amount), idem: art.dataset[keyOf] }, fields || {});
    button.disabled = true;
    say(op === "retry" ? "Trying again…" : "Working…", true);
    try {
      if (op !== "retry") {
        const n = await post("/api/admin/stepup/nonce", { for: "casino_owed" });
        if (!n || !n.ok || !n.nonce) { say((n && n.error) || "Couldn't start the confirmation - reload the page.", false); return; }
        body.nonce = n.nonce;
      }
      const r = await post("/api/casino/admin/owed/" + op, body);
      delete art.dataset[keyOf];
      say(r.ok ? r.message : r.error || "That didn't work.", !!r.ok);
      if (r.ok || r.code === "E_CHANGED" || r.code === "E_LANDED" || r.code === "E_GONE" || r.code === "E_REFUSED") await load();
    } catch (e) {
      say("Couldn't reach the server - reload the page and check the item before trying again.", false);
    } finally {
      button.disabled = false;
      const pw = art.querySelector("input[type=password]");
      if (pw) pw.value = "";
    }
  }
  if (!list) return;
  list.addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b || b.type === "submit") return;
    const art = b.closest(".owed-item");
    if (!art) return;
    if (b.dataset.op === "retry") return send(art, "retry", null, b);
    if (b.dataset.open) {
      for (const f of art.querySelectorAll(".owed-form")) f.hidden = f.dataset.op !== b.dataset.open || !f.hidden;
      const f = art.querySelector(`.owed-form[data-op="${b.dataset.open}"]`);
      if (f && !f.hidden) { const first = f.querySelector("input"); if (first) first.focus(); }
    }
  });
  list.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = ev.target.closest(".owed-form");
    const art = f && f.closest(".owed-item");
    if (!art) return;
    const fields = Object.fromEntries(new FormData(f).entries());
    if (String(fields.reason || "").trim().length < 8) { say("Write a reason (at least 8 characters) - it goes in the admin log.", false); return; }
    const op = f.dataset.op;
    if (op === "writeoff" && !window.confirm(`Write off ${fmt(art.dataset.amount)} PAT to the House? It can't be paid to the member afterwards.`)) return;
    if (op === "redirect" && !window.confirm(`Pay ${fmt(art.dataset.amount)} PAT to ${fields.to}? The original account can't be paid it afterwards.`)) return;
    send(art, op, fields, f.querySelector("button[type=submit]"));
  });
  load();
})();
