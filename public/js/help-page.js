// help-page.js - /help (1.99fq): instant filter, copy buttons, deep links by command or alias, and the
// "ask how to do something" box (local ranking at once, then Pepe's answer for signed-in users via /api/help/ask).
(function () {
  "use strict";
  var HS = window.HelpSearch;
  var idx = [];
  try { idx = JSON.parse(document.getElementById("helpIdx").textContent) || []; } catch (e) { idx = []; }
  var byId = {}, byCmd = {};
  idx.forEach(function (e) {
    byId[e.id] = e;
    [].concat(e.commands || [], e.aliases || []).forEach(function (c) {
      var k = String(c).toLowerCase().replace(/^!/, "");
      if (!byCmd[k]) byCmd[k] = e.id;
    });
  });
  var cards = Array.prototype.slice.call(document.querySelectorAll(".hlp article.card"));
  var cats = Array.prototype.slice.call(document.querySelectorAll(".hlp section.cat"));
  var hay = cards.map(function (c) { return (c.getAttribute("data-cmds") || "") + " " + c.textContent; });

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmt(n) { return Number(n || 0).toLocaleString("en-US"); }

  // ── copy ──
  function copy(text, btn) {
    function done(ok) {
      if (!btn) return;
      var was = btn.getAttribute("data-label") || btn.textContent;
      btn.setAttribute("data-label", was);
      if (btn.classList.contains("cp")) btn.textContent = ok ? "Copied" : "Press Ctrl+C";
      btn.classList.add("ok");
      setTimeout(function () { if (btn.classList.contains("cp")) btn.textContent = was; btn.classList.remove("ok"); }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallback(text)); });
    } else done(fallback(text));
  }
  function fallback(text) {
    var t = document.createElement("textarea");
    t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    t.remove();
    return ok;
  }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest && ev.target.closest("[data-copy]");
    if (b) { ev.preventDefault(); copy(b.getAttribute("data-copy"), b); }
  });

  // ── filter ──
  var flt = document.getElementById("flt"), role = document.getElementById("role"), n = document.getElementById("fltN");
  var none = document.getElementById("noneMsg");
  function applyFilter() {
    var q = flt.value, r = role.value, shown = 0;
    cards.forEach(function (c, i) {
      var ok = (!r || c.getAttribute("data-role") === r) && HS.matches(hay[i], q);
      c.hidden = !ok;
      if (ok) shown++;
    });
    cats.forEach(function (s) {
      var any = !!s.querySelector("article.card:not([hidden])");
      s.hidden = !any;
      var a = document.querySelector('.toc a[data-cat="' + s.id.replace("cat-", "") + '"]');
      if (a) a.classList.toggle("dim", !any);
    });
    n.textContent = (q || r) ? shown + " of " + cards.length : "";
    none.hidden = shown > 0;
  }
  var ft = null;
  flt.addEventListener("input", function () { clearTimeout(ft); ft = setTimeout(applyFilter, 60); });
  role.addEventListener("change", applyFilter);

  // ── deep links: #cmd-<id> or #cmd-<command or alias> ──
  function go(hash, smooth) {
    var m = /^#cmd-([a-z0-9_-]+)$/i.exec(hash || "");
    if (!m) return;
    var id = m[1].toLowerCase(), el = document.getElementById("cmd-" + id);
    if (!el && byCmd[id]) el = document.getElementById("cmd-" + byCmd[id]);
    if (!el) return;
    if (el.hidden || (el.closest("section") || {}).hidden) { flt.value = ""; role.value = ""; applyFilter(); }
    document.querySelectorAll(".hlp .card.hl").forEach(function (c) { c.classList.remove("hl"); });
    el.classList.add("hl");
    el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  }
  window.addEventListener("hashchange", function () { go(location.hash, true); });
  if (location.hash) setTimeout(function () { go(location.hash, false); }, 0);

  // ── ask ──
  var form = document.getElementById("askForm"), input = document.getElementById("askQ");
  var out = document.getElementById("askOut"), hitsEl = document.getElementById("askHits"), pepe = document.getElementById("askPepe");
  var seq = 0;
  function hitHtml(e) {
    return '<li><a href="#cmd-' + esc(e.id) + '"><code>' + esc((e.syntax || [e.title])[0]) + "</code>" +
      (e.cost ? ' <span class="b cost">' + fmt(e.cost) + " PAT</span>" : "") +
      (e.role && e.role !== "everyone" ? ' <span class="b ' + esc(e.role) + '">' + esc({ mod: "Mods", owner: "Pad owners", admin: "Admins" }[e.role] || e.role) + "</span>" : "") +
      "<small>" + esc(e.summary) + "</small></a></li>";
  }
  function showHits(list) {
    hitsEl.innerHTML = list.length ? list.map(hitHtml).join("") : '<li class="pepe note">No command matches that. Try other words, or filter the list below.</li>';
  }
  function say(cls, html) { pepe.className = "pepe" + (cls ? " " + cls : ""); pepe.innerHTML = html; pepe.hidden = !html; }
  // Pepe's text: escaped, then each !command he names links to its card
  function linkCmds(text) {
    return esc(text).replace(/!([a-z0-9_]+)/gi, function (m, c) {
      var id = byCmd[c.toLowerCase()];
      return id ? '<a href="#cmd-' + esc(id) + '"><code>' + m + "</code></a>" : "<code>" + m + "</code>";
    });
  }
  var NOTES = {
    signin: '<a href="/login?next=/help">Sign in</a> and Pepe answers your question in his own words too.',
    "pepe-offline": "Pepe isn't around to answer right now, so here's what the search found.",
    "pepe-slow": "Pepe is taking too long to answer, so here's what the search found.",
    "pepe-error": "Pepe couldn't answer that one, so here's what the search found.",
    "ai-off": "",
    nothing: "",
    busy: "Pepe is busy with other questions right now. Here's what the search found.",
    "limit-burst": "You've asked Pepe a lot just now. Here's what the search found (Pepe answers again in a few minutes).",
    "limit-day": "That's all of Pepe's answers for today. The search still works.",
    "limit-ip": "Lots of questions from your network right now. Here's what the search found.",
  };
  function ask(q) {
    q = String(q || "").trim();
    if (q.length < 2) return;
    var my = ++seq;
    out.hidden = false;
    var local = HS.rank(idx, q, { limit: 5 }).map(function (r) { return r.entry; });
    showHits(local);
    if (window.HELP_SIGNED_IN) say("wait", "🐸 Pepe is thinking…"); else say("note", NOTES.signin);
    try { history.replaceState(null, "", "?q=" + encodeURIComponent(q) + location.hash); } catch (e) { /* ignore */ }
    fetch("/api/help/ask", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, body: JSON.stringify({ q: q }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (my !== seq) return;
        if (!d || !d.ok) { say("note", esc((d && d.error) || "Something went wrong.")); return; }
        if (d.answer) {
          say("", '<span class="who">🐸 Pepe:</span>' + linkCmds(d.answer.text || "I don't know a command for that."));
          var first = (d.answer.ids || []).map(function (id) { return byId[id]; }).filter(Boolean);
          var rest = local.filter(function (e) { return (d.answer.ids || []).indexOf(e.id) < 0; });
          showHits(first.concat(rest).slice(0, 5));
        } else {
          var note = NOTES[d.note];
          if (note === undefined) note = "";
          if (d.note === "signin" && window.HELP_SIGNED_IN) note = "";
          say("note", note);
        }
      })
      .catch(function () { if (my === seq) say("note", window.HELP_SIGNED_IN ? NOTES["pepe-error"] : NOTES.signin); });
  }
  form.addEventListener("submit", function (ev) { ev.preventDefault(); ask(input.value); });
  document.querySelectorAll("[data-ask]").forEach(function (b) {
    b.addEventListener("click", function () { input.value = b.getAttribute("data-ask"); ask(input.value); });
  });
  if (input.value) ask(input.value);
  applyFilter();
})();
