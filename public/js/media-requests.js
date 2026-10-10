// public/js/media-requests.js — 1.99ji: /requests (mediarequests.js). Search Overseerr, pick, request.
(function () {
  "use strict";
  var root = document.getElementById("mreq");
  if (!root) return;
  var form = document.getElementById("mrForm"), results = document.getElementById("mrResults"), pick = document.getElementById("mrPick"), msgEl = document.getElementById("mrMsg");
  var price = { movie: Number(root.getAttribute("data-price-movie")) || 0, tv: Number(root.getAttribute("data-price-tv")) || 0 };
  var IMG = "https://image.tmdb.org/t/p/w185";
  var AV = { unknown: "", pending: "Requested", processing: "On its way", partial: "Partly on Plex", available: "On Plex ✓", blocked: "Not available", deleted: "" };
  var cur = null;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function say(t, good) { msgEl.textContent = t || ""; msgEl.style.color = good ? "#9ccc65" : ""; }
  function api(method, url, body) {
    var o = { method: method, credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body) { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(body); }
    return fetch(url, o).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }).then(function (j) {
        if (!r.ok || j.ok === false) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }
  function img(p) { return p ? '<img loading="lazy" alt="" src="' + IMG + esc(p) + '">' : '<span class="mr-ph"></span>'; }
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var q = form.q.value.trim();
    if (q.length < 2) return;
    say("Searching…", true);
    pick.classList.add("hide");
    api("GET", "/api/requests/search?q=" + encodeURIComponent(q)).then(function (j) {
      results.innerHTML = (j.results || []).map(function (x) {
        return '<button type="button" class="mr-it" data-type="' + esc(x.type) + '" data-tmdb="' + esc(x.tmdb) + '">' + img(x.poster) +
          "<b>" + esc(x.title) + "</b><small>" + (x.type === "tv" ? "Show" : "Movie") + (x.year ? " · " + x.year : "") + (AV[x.availability] ? " · " + AV[x.availability] : "") + "</small></button>";
      }).join("") || '<p class="muted">Nothing found.</p>';
      say("");
    }).catch(function (e) { say(e.message); });
  });
  results.addEventListener("click", function (ev) {
    var b = ev.target.closest(".mr-it");
    if (!b) return;
    say("Loading…", true);
    api("GET", "/api/requests/title/" + encodeURIComponent(b.getAttribute("data-type")) + "/" + encodeURIComponent(b.getAttribute("data-tmdb"))).then(function (j) {
      var t = cur = j.title;
      var h = "<div><b>" + esc(t.title) + "</b>" + (t.year ? " (" + t.year + ")" : "") + (AV[t.availability] ? ' <span class="muted">· ' + AV[t.availability] + "</span>" : "") + "</div>";
      if (t.availability === "available") h += '<p class="muted">It\'s already on Plex — enjoy!</p>';
      else if (t.type === "movie" && (t.availability === "pending" || t.availability === "processing")) h += '<p class="muted">Someone already asked for it — it\'s on its way.</p>';
      else {
        if (t.type === "tv") {
          h += '<div class="mr-seasons">' + (t.seasons || []).map(function (s) {
            var done = s.status >= 4 || s.status === 2 || s.status === 3;
            return "<label><input type=\"checkbox\" value=\"" + s.n + "\"" + (done ? " disabled" : " checked") + "> Season " + s.n +
              (s.episodes ? ' <span class="muted">(' + s.episodes + ")</span>" : "") + (AV[s.availability] ? ' <span class="muted">· ' + AV[s.availability] + "</span>" : "") + "</label>";
          }).join("") + "</div>";
        }
        var p = price[t.type];
        h += '<div class="row"><button type="button" class="btn primary" data-req>Request it' + (p ? " (" + p.toLocaleString("en-US") + " PAT or a credit)" : "") + "</button></div>";
      }
      pick.innerHTML = h;
      pick.classList.remove("hide");
      say("");
      pick.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }).catch(function (e) { say(e.message); });
  });
  pick.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-req]");
    if (!b || !cur) return;
    var body = { type: cur.type, tmdb: cur.tmdb };
    if (cur.type === "tv") {
      body.seasons = Array.prototype.map.call(pick.querySelectorAll(".mr-seasons input:checked"), function (i) { return Number(i.value); });
      if (!body.seasons.length) { say("Pick at least one season."); return; }
    }
    b.disabled = true;
    say("Sending…", true);
    api("POST", "/api/requests", body).then(function (j) {
      say("✓ Requested — " + j.label + (j.paid_with === "credit" ? " (used a credit)" : j.price ? " (" + j.price.toLocaleString("en-US") + " PAT)" : "") + ". Reloading…", true);
      setTimeout(function () { location.reload(); }, 1500);
    }).catch(function (e) { say(e.message); b.disabled = false; });
  });
})();
