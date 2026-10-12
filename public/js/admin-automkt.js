// public/js/admin-automkt.js - 1.99th: /admin/markets (automkt.js). Renders Pepe's last status push and queues requests for him.
(function () {
  "use strict";
  var el = document.getElementById("amData");
  if (!el) return;
  var A = {};
  try { A = JSON.parse(el.textContent || "{}"); } catch (e) { A = {}; }
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function when(sec) { return sec ? new Date(Number(sec) * 1000).toISOString().slice(0, 16).replace("T", " ") : "-"; }
  function whenMs(ms) { return ms ? new Date(Number(ms)).toISOString().slice(0, 16).replace("T", " ") : "-"; }
  function num(n) { return Number(n || 0).toLocaleString("en-US"); }
  function post(body) {
    return fetch("/api/admin/automkt", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }); });
  }
  function say(node, text, ok) { if (!node) return; node.textContent = text; node.className = "adm-msg " + (ok ? "ok" : "err"); }
  function reload() {
    return fetch("/api/admin/automkt", { credentials: "same-origin" }).then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok) { A = j; render(); } }).catch(function () {});
  }
  function queued(node, j, what) {
    if (j && j.ok) { A = j; render(); say(node, what + " sent to Pepe - he picks it up within a minute.", true); setTimeout(reload, 20000); setTimeout(reload, 70000); }
    else say(node, (j && j.error) || "Failed.", false);
  }

  function stateLine(v) {
    var m = v.market || {};
    if (v.status !== "live") return esc(v.status) + (v.note ? " - " + esc(v.note) : "");
    var s = esc(m.status || "?");
    if (m.result) s += ": <b>" + esc(m.result) + "</b>";
    if (m.void_reason) s += " (" + esc(m.void_reason) + ")";
    if (m.ai_state && m.status !== "settled" && m.status !== "void") s += " · judge " + esc(m.ai_state) + (m.ai_result ? " " + esc(m.ai_result) : "") + (m.escalated ? " <b>(needs an admin)</b>" : "");
    var ev = (v.evidence || []).slice(-1)[0];
    if (ev && ev.why) s += "<div class=\"adm-help\">" + esc(ev.why) + "</div>";
    else if (m.ai_evidence) s += "<div class=\"adm-help\">" + esc(m.ai_evidence) + "</div>";
    return s;
  }

  function render() {
    var S = A.state || {};
    var c = S.cfg || {};
    var w = S.week || {};
    say($("amOnline"), A.at ? (A.online ? "Pepe synced " + whenMs(A.at) + " UTC" : "Pepe last synced " + whenMs(A.at) + " UTC (offline?)") : "Pepe hasn't synced yet", !!A.online);
    var f = $("amForm");
    if (f && S.cfg && !f.dataset.dirty) {
      f.enabled.checked = !!c.enabled; f.per_week.value = c.per_week; f.review.value = c.review;
      f.cat_sports.checked = !!(c.cats || {}).sports; f.cat_prices.checked = !!(c.cats || {}).prices; f.cat_news.checked = !!(c.cats || {}).news;
      f.announce.checked = !!c.announce; f.announce_gap_min.value = c.announce_gap_min; f.feed_post.checked = !!c.feed_post; f.seed_cap_week.value = c.seed_cap_week;
      var o = S.options || {};
      var box = function (k, label) {
        var sel = c[k] || [];
        return "<fieldset class=\"adm-fs\"><legend>" + label + "</legend>" + Object.keys(o[k] || {}).map(function (x) {
          return "<label class=\"adm-check\"><input type=\"checkbox\" data-list=\"" + k + "\" value=\"" + esc(x) + "\"" + (sel.indexOf(x) >= 0 ? " checked" : "") + "> " + esc(o[k][x]) + "</label>";
        }).join("") + "</fieldset>";
      };
      $("amLists").innerHTML = box("leagues", "Leagues") + box("assets", "Assets") + box("feeds", "News feeds");
    }
    $("amWeek").innerHTML = S.cfg ? ("This week: <b>" + num(w.count) + " / " + num(w.target) + "</b> (" + Object.keys(w.by_cat || {}).map(function (k) { return esc(k) + " " + num(w.by_cat[k]); }).join(", ") + ")"
      + " · next " + (c.enabled ? (S.next_due ? when(S.next_due) + " UTC" : "-") : "off") + " · auto seed this week " + num(w.seed_used) + " / " + num(w.seed_cap) + " PAT"
      + (S.busy ? " · <b>working…</b>" : "")) : "";
    var pv = S.preview;
    $("amPreview").innerHTML = pv && pv.items ? ("<h3>Preview (" + when(pv.at) + " UTC)</h3>" + (pv.items.length ? "<ul>" + pv.items.map(function (p) {
      return "<li>[" + esc(p.cat) + (p.tag ? " · " + esc(p.tag) : "") + "] <b>" + esc(p.question) + "</b> " + esc((p.options || []).join(" / ")) + " · closes " + when(p.closes) + " · resolves " + when(p.resolve_at)
        + (p.review ? " · <i>needs review</i>" : "") + "<div class=\"adm-help\">" + esc(p.criteria) + " <a href=\"" + esc(p.source_url) + "\" target=\"_blank\" rel=\"noopener\">source</a></div></li>";
    }).join("") + "</ul>" : "<p class=\"adm-help\">Nothing suitable right now.</p>")
      + ((pv.skipped || []).length ? "<details><summary>Skipped (" + pv.skipped.length + ")</summary><ul class=\"adm-help\">" + pv.skipped.map(function (s) { return "<li>" + esc(s.question) + " - " + esc(s.why) + "</li>"; }).join("") + "</ul></details>" : "")) : "";
    var rv = S.review || [];
    $("amReview").innerHTML = rv.length ? rv.map(function (v) {
      return "<tr><td>" + esc(v.id) + "</td><td><b>" + esc(v.question) + "</b><div class=\"adm-help\">" + esc(v.criteria) + " <a href=\"" + esc(v.source_url) + "\" target=\"_blank\" rel=\"noopener\">source</a></div></td><td>"
        + when(v.closes) + "</td><td>" + when(v.resolve_at) + "</td><td><button type=\"button\" data-ok=\"" + esc(v.id) + "\">✅ Approve</button> <button type=\"button\" class=\"adm-btn danger\" data-no=\"" + esc(v.id) + "\">Reject</button></td></tr>";
    }).join("") : "<tr><td class=\"empty\" colspan=\"5\">Nothing waiting.</td></tr>";
    var it = S.items || [];
    $("amItems").innerHTML = it.length ? it.map(function (v) {
      var ref = v.ref ? "<a href=\"/markets/" + esc(String(v.ref).replace(/^M/, "")) + "\">" + esc(v.ref) + "</a>" : esc(v.id);
      return "<tr><td>" + ref + "</td><td>" + esc(v.cat) + (v.tag ? " · " + esc(v.tag) : "") + "<br>" + esc(v.model || v.kind || "") + "</td><td>" + esc(v.question) + "</td><td>" + when(v.closes) + "</td><td>" + when(v.resolve_at) + "</td><td>" + stateLine(v) + "</td></tr>";
    }).join("") : "<tr><td class=\"empty\" colspan=\"6\">None yet.</td></tr>";
    $("amReqs").innerHTML = (A.requests || []).length ? A.requests.map(function (r) {
      return "<tr><td>" + whenMs(r.at) + "</td><td>" + esc(r.by) + "</td><td>" + esc(r.action) + " " + esc(JSON.stringify(r.args || {})).slice(0, 160) + "</td><td>"
        + (r.status === "done" ? (r.ok ? "✅ " : "❌ ") + esc(r.message) : esc(r.status)) + "</td></tr>";
    }).join("") : "<tr><td class=\"empty\" colspan=\"4\">No requests yet.</td></tr>";
    $("amRuns").innerHTML = (S.runs || []).map(function (r) { return "<li>" + when(r.at) + " UTC · " + esc(r.kind) + " by " + esc(r.by) + ": " + esc(r.text) + "</li>"; }).join("") || "<li>No runs yet.</li>";
    $("amSources").innerHTML = (S.sources || []).map(function (s) { return "<li><b>" + esc(s.name) + "</b> (" + esc(s.for) + ") - " + esc(s.terms) + "</li>"; }).join("");
  }

  var f = $("amForm");
  if (f) {
    f.addEventListener("change", function () { f.dataset.dirty = "1"; });
    f.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var lists = { leagues: [], assets: [], feeds: [] };
      Array.prototype.forEach.call(f.querySelectorAll("[data-list]"), function (x) { if (x.checked) lists[x.dataset.list].push(x.value); });
      var cfg = { enabled: f.enabled.checked, per_week: Number(f.per_week.value), review: f.review.value,
                  cats: { sports: f.cat_sports.checked, prices: f.cat_prices.checked, news: f.cat_news.checked },
                  announce: f.announce.checked, announce_gap_min: Number(f.announce_gap_min.value), feed_post: f.feed_post.checked,
                  seed_cap_week: Number(f.seed_cap_week.value), leagues: lists.leagues, assets: lists.assets, feeds: lists.feeds };
      post({ action: "set", args: { cfg: cfg } }).then(function (j) { delete f.dataset.dirty; queued(f.querySelector("[data-msg]"), j, "Settings"); });
    });
  }
  $("amGen").addEventListener("click", function () {
    var n = Math.max(1, Math.min(10, Number($("amN").value) || 1));
    post({ action: "generate", args: { n: n } }).then(function (j) { queued($("amGenMsg"), j, "Generate " + n); });
  });
  $("amPrev").addEventListener("click", function () {
    post({ action: "preview", args: { n: 3 } }).then(function (j) { queued($("amGenMsg"), j, "Preview"); });
  });
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("[data-ok],[data-no]") : null;
    if (!b) return;
    var ok = b.hasAttribute("data-ok");
    var id = b.getAttribute(ok ? "data-ok" : "data-no");
    var why = ok ? "" : (window.prompt("Why reject it? (optional)") || "");
    post({ action: ok ? "approve" : "reject", args: { id: id, why: why } }).then(function (j) { queued($("amRevMsg"), j, (ok ? "Approve " : "Reject ") + id); });
  });
  render();
  setInterval(reload, 60000);
})();
