// admin-mtt.js — the 🏆 tournament schedule manager (/admin/casino/mtt; hand-off 22 phase 2, 1.99??; casino/mtt.js). The lists, the
// create / edit form with live previews (the fee, the late-entry depth in big blinds, the estimated length and end, the projected payouts at
// max entries, the most a guarantee could add vs the caps, an on-air warning) and every row's actions - all JSON fetch, every one audited.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Math.trunc(Number(n) || 0).toLocaleString("en-US");
  const et = (ms) => { try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms)) + " ET"; } catch (e) { return new Date(ms).toISOString(); } };
  async function api(url, body) {
    const r = await fetch(url, body ? { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, body: JSON.stringify(body) }
                                    : { credentials: "same-origin", cache: "no-store" });
    let j = {};
    try { j = await r.json(); } catch (e) { j = { ok: false, error: "HTTP " + r.status }; }
    return j;
  }
  let data = null;
  const form = $("mttForm");
  const LADDER = [[10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [400, 800], [600, 1200], [800, 1600], [1000, 2000]];
  const niceUp = (bb) => { const x = bb * 1.5, u = Math.pow(10, Math.max(0, Math.floor(Math.log10(x)) - 1)), r = Math.round(x / u) * u; return r > bb ? r : bb + u; };
  const levelAt = (lv, i) => { if (i < lv.length) return lv[i]; let bb = lv[lv.length - 1][1]; for (let j = lv.length - 1; j < i; j++) bb = niceUp(bb); return [Math.floor(bb / 2), bb]; };
  function parseLevels(s) { const out = []; for (const p of String(s || "").split(",")) { const m = /^(\d+)\/(\d+)$/.exec(p.trim()); if (m) out.push([Number(m[1]), Number(m[2])]); } return out.length ? out : LADDER; }
  function curve(E, st) {
    const small = String(st.mtt_payouts_small || "100|65,35|50,30,20").split("|").map((b) => b.split(",").map(Number));
    if (E <= 3) return small[0].map((p) => p * 100);
    if (E <= 6) return small[1].map((p) => p * 100);
    if (E <= 9) return small[2].map((p) => p * 100);
    const n = Math.min(E - 1, Math.max(st.mtt_min_paid || 3, Math.floor((E * (st.mtt_paid_pct || 15)) / 100)));
    const w = []; for (let i = 1; i <= n; i++) w.push(Math.pow(i, -Number(st.mtt_curve_exp || 0.9)));
    const sum = w.reduce((a, b) => a + b, 0), bp = w.map((x) => Math.floor((10000 * x) / sum));
    bp[0] += 10000 - bp.reduce((a, b) => a + b, 0);
    return bp;
  }
  function preview() {
    if (!data) return;
    const st = data.settings || {};
    const f = Object.fromEntries(new FormData(form).entries());
    const buyin = Number(f.buyin) || 0, fee = Math.floor((buyin * (st.mtt_fee_pct || 0)) / 100);
    const chips = Number(f.start_chips) || st.mtt_start_chips || 1500, max = Number(f.max_entries) || Math.min(180, st.mtt_max_field || 180);
    const mins = f.structure === "turbo" ? st.mtt_turbo_mins || 3 : st.mtt_level_mins || 5;
    const lv = parseLevels(st.mtt_levels);
    const late = f.late_levels === "" || f.late_levels == null ? st.mtt_late_levels : Number(f.late_levels);
    const [, lbb] = levelAt(lv, Math.max(0, late - 1));
    let L = 0; while (L < 400 && levelAt(lv, L)[1] < (max * chips) / 20) L++;
    const est = (L + 1) * mins * 60000;
    const bp = curve(max, st), P = buyin * max;
    const pays = bp.slice(0, 9).map((b, i) => `${i + 1}. ${fmt(Math.floor((P * b) / 10000))}`).join(" · ") + (bp.length > 9 ? ` … (${bp.length} paid)` : "");
    const G = Number(f.guarantee) || 0, minE = Number(f.min_entries) || st.mtt_min_entries || 2;
    const start = f.start ? new Date(f.start) : null;
    const lines = [`Entry: <b>${fmt(buyin)} + ${fmt(fee)} PAT</b> (${st.mtt_fee_pct}% fee to the House)`,
                   `Late entry depth: <b>${lbb ? Math.floor(chips / lbb) : "—"} BB</b> (${late} levels)`,
                   `Estimated length: <b>${Math.round(est / 6e5) / 10} h</b> (${L + 1} levels of ${mins} min)${start ? `, ends about ${esc(et(start.getTime() + est))}` : ""}`,
                   `Projected payouts at ${fmt(max)} entries: ${esc(pays)} PAT`];
    if (G) lines.push(`Guarantee: the most it could add is <b>${fmt(Math.max(0, G - minE * buyin))} PAT</b> (cap ${fmt(st.mtt_overlay_cap)}; weekly cap ${fmt(st.mtt_overlay_week_cap)}) - ${esc(data.gate.text)}`);
    if (data.onair && start) {
      const from = start.getTime() + 0.7 * est, to = start.getTime() + Math.min(12 * 3600e3, 1.5 * est);
      const clash = data.onair.filter((b) => b.at && b.at >= from && b.at <= to);
      if (clash.length) lines.push(`⚠️ An on-air booking falls when the final table may play (${clash.length}) - the final table waits for the scene.`);
    }
    $("mttPreview").innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
  }
  const STATES = [["Upcoming", ["scheduled"]], ["Registering", ["registering"]], ["Running", ["running", "finishing", "settled"]], ["Finished", ["done"]], ["Cancelled", ["cancelled"]]];
  function rowActs(r) {
    const a = [`<button type="button" class="adm-btn ghost" data-act="view" data-id="${esc(r.id)}">Open</button>`];
    if (["scheduled", "registering", "running"].includes(r.status)) a.push(`<button type="button" class="adm-btn ghost" data-act="edit" data-id="${esc(r.id)}">Edit</button>`);
    if (["scheduled", "registering"].includes(r.status)) a.push(`<button type="button" class="adm-btn ghost" data-act="delay" data-id="${esc(r.id)}">Delay</button>`, `<button type="button" class="adm-btn ghost" data-act="max" data-id="${esc(r.id)}">Raise max</button>`);
    if (r.status === "registering") a.push(`<button type="button" class="adm-btn ghost" data-act="start" data-id="${esc(r.id)}">Start now</button>`);
    if (r.status === "running") a.push(`<button type="button" class="adm-btn ghost" data-act="pause" data-id="${esc(r.id)}">Pause</button>`, `<button type="button" class="adm-btn ghost" data-act="resume" data-id="${esc(r.id)}">Resume</button>`,
                                       `<button type="button" class="adm-btn ghost" data-act="stream-on" data-id="${esc(r.id)}">Stream on</button>`, `<button type="button" class="adm-btn ghost" data-act="stream-off" data-id="${esc(r.id)}">Stream off</button>`);
    if (["scheduled", "registering", "running"].includes(r.status)) a.push(`<button type="button" class="adm-btn ghost" data-act="cancel" data-id="${esc(r.id)}">Cancel</button>`);
    if (r.status === "finishing") a.push(`<button type="button" class="adm-btn ghost" data-act="void" data-id="${esc(r.id)}">Void and refund (owner)</button>`);
    if (r.overlay === "owed") a.push(`<button type="button" class="adm-btn ghost" data-act="overlay-retry" data-id="${esc(r.id)}">Retry the guarantee (owner)</button>`);
    a.push(`<button type="button" class="adm-btn ghost" data-act="log" data-id="${esc(r.id)}">Log</button>`);
    return a.join(" ");
  }
  function render() {
    const list = data.list || [];
    $("mttList").innerHTML = STATES.map(([h, st]) => {
      const rows = list.filter((r) => st.includes(r.status));
      if (!rows.length) return `<h3>${h}</h3><p class="adm-help">None.</p>`;
      return `<h3>${h}</h3><div class="adm-tablewrap"><table class="adm-table"><thead><tr><th>#</th><th>Title</th><th>Start</th><th>Est. end</th><th>Buy-in</th><th>GTD</th><th>Entries</th><th>Status</th><th>Overlay</th><th></th></tr></thead><tbody>` +
        rows.map((r) => `<tr><td>${esc(r.no)}</td><td><a href="${esc(r.url)}">${esc(r.title)}</a></td><td>${esc(et(r.start_at))}</td><td>${esc(et(r.est_end))}</td><td>${r.freeroll ? "freeroll" : esc(fmt(r.buyin) + " + " + fmt(r.fee))}</td>` +
          `<td>${r.guarantee ? esc(fmt(r.guarantee)) : "—"}</td><td>${esc(fmt(r.status === "running" ? r.entries : r.registered))}/${esc(fmt(r.max_entries))}</td><td>${esc(r.status)}${r.cancelled ? " (" + esc(r.cancelled) + ")" : ""}</td>` +
          `<td>${esc(r.overlay || "—")}</td><td class="adm-actions">${rowActs(r)}</td></tr>`).join("") + "</tbody></table></div>";
    }).join("");
    $("mttGateText").textContent = data.gate.text + (data.gate.switch === "on" ? " (mtt_guarantees on)" : " (mtt_guarantees off)");
    const st = data.settings || {};
    const sel = $("mttBuyin");
    const opts = String(st.mtt_buyins || "1000,5000,25000,100000").split(",").map(Number);
    const sig = opts.join() + "|" + data.gate.spend;
    if (sel.dataset.v !== sig) {
      sel.dataset.v = sig;
      sel.innerHTML = opts.map((b) => `<option value="${b}">${fmt(b)} PAT</option>`).join("") + (data.gate.spend === "available" && data.gate.switch === "on" ? '<option value="0">0 - a freeroll</option>' : "");
    }
    $("mttGtd").disabled = !(data.gate.spend === "available" && data.gate.switch === "on");
    if ($("mttGtd").disabled) { $("mttGtd").value = "0"; $("mttGtd").title = data.gate.text; }
    for (const [k, v] of [["start_chips", st.mtt_start_chips], ["max_entries", Math.min(180, st.mtt_max_field || 180)], ["min_entries", st.mtt_min_entries], ["late_levels", st.mtt_late_levels], ["table_size", st.mtt_table_size]]) {
      const el = form.elements[k];
      if (el && !el.value) el.value = v;
    }
    $("mttRooms").placeholder = (data.rooms || []).map((r) => r.id).join(", ") || "PepeLab";
    preview();
  }
  // (review) Edit fills the WHOLE form from the tournament (its admin view) - it used to fill the title only, and the submit sent every field
  // (the select's first buy-in, "standard", empty rooms...). Once registration is open only the title and the rooms can change: the rest is
  // disabled (FormData leaves it out). An unchanged start goes back as start_at (the stored instant, not a re-parsed minute).
  const FIXED = ["start", "reg_opens", "buyin", "structure", "start_chips", "table_size", "max_entries", "min_entries", "late_levels", "reentry_max", "guarantee", "repeat", "count"];
  const etLocal = (ms) => {
    try {
      const p = {};
      for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms))) p[x.type] = x.value;
      return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
    } catch (e) { return ""; }
  };
  function unlock() {
    for (const n of FIXED) if (form.elements[n]) form.elements[n].disabled = false;
    form.elements.start.required = true;
    form.dataset.start0 = ""; form.dataset.startAt = ""; form.dataset.reg0 = "";
  }
  function fill(m) {
    form.reset();
    unlock();
    const set = (k, v) => { const el = form.elements[k]; if (el) el.value = v == null ? "" : String(v); };
    const s = m.structure || {};
    set("id", m.id); set("title", m.title);
    set("start", etLocal(m.start_at)); set("reg_opens", m.status === "scheduled" && m.reg_opens_at > Date.now() ? etLocal(m.reg_opens_at) : "");
    set("buyin", m.buyin); set("structure", s.kind); set("start_chips", s.start_chips); set("table_size", s.table_size); set("max_entries", m.max_entries);
    set("min_entries", m.min_entries); set("late_levels", s.late_levels); set("reentry_max", s.reentry_max); set("guarantee", m.guarantee || 0);
    set("rooms", (m.rooms || []).join(", ")); set("repeat", "none"); set("count", "1");
    form.dataset.start0 = form.elements.start.value; form.dataset.startAt = String(m.start_at); form.dataset.reg0 = form.elements.reg_opens.value;
    const open = m.status !== "scheduled";
    for (const n of FIXED) if (form.elements[n]) form.elements[n].disabled = open;
    form.elements.start.required = !open;
    $("mttSave").textContent = "Save changes";
    preview();
  }
  async function load() {
    const j = await api("/api/casino/admin/mtt");
    if (!j.ok) { $("mttList").textContent = j.error || "Couldn't load them."; return; }
    data = j;
    render();
  }
  form.addEventListener("input", preview);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form).entries());
    const body = Object.assign({}, f, { rooms: String(f.rooms || "").split(",").map((x) => x.trim()).filter(Boolean) });
    if (!body.id) delete body.id;
    if (body.id && "start" in body && body.start === form.dataset.start0 && form.dataset.startAt) { delete body.start; body.start_at = Number(form.dataset.startAt); }
    if (body.id && "reg_opens" in body && body.reg_opens === form.dataset.reg0) delete body.reg_opens;
    $("mttSave").disabled = true;
    const j = await api("/api/casino/admin/mtt", body);
    $("mttSave").disabled = false;
    $("mttStatus").textContent = j.ok ? (j.nos ? `Scheduled #${j.nos.join(", #")}` : "Saved") : j.error || "That didn't work.";
    if (j.ok) { form.reset(); unlock(); form.elements.id.value = ""; $("mttSave").textContent = "Schedule"; load(); }
  });
  $("mttReset").addEventListener("click", () => { form.reset(); unlock(); form.elements.id.value = ""; $("mttSave").textContent = "Schedule"; preview(); });
  async function detail(id) {
    const j = await api(`/api/casino/admin/mtt/${encodeURIComponent(id)}`);
    if (!j.ok) return;
    const m = j.mtt;
    $("mttDetail").hidden = false;
    $("mttDetailT").textContent = `#${m.no} ${m.title}`;
    $("mttDetailBody").innerHTML = `<p class="adm-help">${esc(m.status)} · level ${esc(m.level)} (${esc(fmt(m.sb))}/${esc(fmt(m.bb))}) · ${esc(fmt(m.players_left))}/${esc(fmt(m.entries))} left · ` +
      `${esc(m.tables.length)} table(s)${m.slowest_table ? ` · slowest: table ${esc(m.slowest_table)}` : ""} · scene ${m.scene_held ? "held by the show" : "free"} · stream ${m.stream_off ? "off (admin)" : esc(m.stream)}` +
      `${m.finish ? ` · finish ${esc(m.finish.state)}${m.finish.last_code ? " (" + esc(m.finish.last_code) + ")" : ""}${m.finish.overlay ? `, guarantee ${esc(m.finish.overlay.state)}` : ""}` : ""}</p>` +
      `<div class="adm-tablewrap"><table class="adm-table"><thead><tr><th>n</th><th>Name</th><th>Via</th><th>State</th><th>Entry</th><th>Place</th><th>Prize</th><th></th></tr></thead><tbody>` +
      m.entries.map((e) => `<tr><td>${e.n}</td><td>${esc(e.name)}</td><td>${esc(e.via)}</td><td>${esc(e.state)}${e.dq ? " (DQ)" : ""}</td><td>${esc(e.entry_no || "—")}</td><td>${esc(e.place || "—")}</td><td>${e.prize ? esc(fmt(e.prize)) : "—"}</td>` +
        `<td>${e.state === "held" && m.status === "registering" ? `<button type="button" class="adm-btn ghost" data-entry="refund" data-id="${esc(m.id)}" data-n="${e.n}">Refund</button>` : ""}` +
        `${e.state === "playing" ? `<button type="button" class="adm-btn ghost" data-entry="dq" data-id="${esc(m.id)}" data-n="${e.n}">Disqualify</button>` : ""}</td></tr>`).join("") + "</tbody></table></div>";
  }
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act], button[data-entry]");
    if (!b || b.disabled) return;
    const id = b.dataset.id, act = b.dataset.act;
    if (act === "view") return detail(id);
    if (act === "log") { const j = await api(`/api/casino/admin/mtt/${encodeURIComponent(id)}/log`); alert((j.log || []).map((l) => `${new Date(l.ts).toISOString().slice(0, 19)} ${l.kind} ${JSON.stringify(l.data || {})}`).join("\n") || "Empty."); return; }
    if (act === "edit") {
      const j = await api(`/api/casino/admin/mtt/${encodeURIComponent(id)}`);
      if (!j.ok || !j.mtt) { alert(j.error || "Couldn't load it."); return; }
      fill(j.mtt);
      form.scrollIntoView({ behavior: "smooth" });
      return;
    }
    let body = {}, url = `/api/casino/admin/mtt/${encodeURIComponent(id)}/${act}`;
    if (b.dataset.entry) {
      url = `/api/casino/admin/mtt/${encodeURIComponent(id)}/entry/${encodeURIComponent(b.dataset.n)}/${b.dataset.entry}`;
      if (b.dataset.entry === "dq") { const why = prompt("Disqualify this player? Their chips leave play (before the money only). Reason:"); if (!why) return; body = { reason: why }; }
      else if (!confirm("Refund this entry in full?")) return;
    } else if (act === "delay") { const m = prompt("Delay the start by how many minutes? (6 h in all at most)", "15"); if (!m) return; body = { minutes: Number(m) }; }
    else if (act === "max") { const m = prompt("Raise max entries to:"); if (!m) return; body = { max_entries: Number(m) }; }
    else if (act === "cancel" || act === "void") {
      const typed = prompt(`${act === "void" ? "Void and refund" : "Cancel"} this tournament? Every entry is refunded in full (buy-in and fee). Type CANCEL to confirm.`);
      if (typed !== "CANCEL") return;
      const why = prompt("Reason (the admin log):"); if (!why) return;
      body = { confirm: true, reason: why };
    } else if (act === "stream-on" || act === "stream-off") { url = `/api/casino/admin/mtt/${encodeURIComponent(id)}/stream`; body = { on: act === "stream-on" }; }
    b.disabled = true;
    const j = await api(url, body);
    b.disabled = false;
    alert(j.ok ? "Done." : j.error || "That didn't work.");
    load();
  });
  load();
})();
