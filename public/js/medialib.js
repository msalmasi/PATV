// public/js/medialib.js — 1.99ji: the 📼 Play from library panel (views/partials/media-library.ejs, medialib.js).
(function () {
  "use strict";
  var root = document.getElementById("mediaLibrary");
  if (!root) return;
  var fixedRoom = root.getAttribute("data-room") || "";
  var roomSel = document.getElementById("mlRoom");
  var statusEl = document.getElementById("mlStatus");
  var nowEl = document.getElementById("mlNow");
  var resultsEl = document.getElementById("mlResults");
  var pickEl = document.getElementById("mlPick");
  var msgEl = document.getElementById("mlMsg");
  var form = document.getElementById("mlSearch");
  var defaultQuality = 720;
  var picked = null;

  function room() { return fixedRoom || (roomSel ? roomSel.value : ""); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function hms(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
  }
  function parseTime(v) {
    var p = String(v || "").trim().split(":").map(Number);
    if (!p.length || p.some(function (n) { return !isFinite(n) || n < 0; })) return null;
    var t = 0;
    for (var i = 0; i < p.length; i++) t = t * 60 + p[i];
    return Math.floor(t);
  }
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

  // ── now playing ──
  function drawNow(st) {
    // a pad's settings show that pad's stream; the admin page shows every pad's
    var mine = fixedRoom ? (st.sessions || []).filter(function (s) { return s.room === fixedRoom; }) : (st.sessions || []);
    nowEl.innerHTML = mine.map(function (s) {
      var pct = s.duration ? Math.min(100, 100 * (s.position || 0) / s.duration) : 0;
      var paused = s.state === "paused";
      return '<div class="ml-now" data-room="' + esc(s.room) + '" data-pos="' + Math.floor(s.position || 0) + '">' +
        '<div><b>' + esc(s.title) + '</b> <span class="muted">· ' + esc(s.room) + ' · ' + esc(s.state) + ' · by ' + esc(s.by) + '</span></div>' +
        '<div class="ml-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(pct) + '"><span style="width:' + pct.toFixed(1) + '%"></span></div>' +
        '<div class="muted">' + hms(s.position) + (s.duration ? " / " + hms(s.duration) : "") + (s.error ? ' · <span style="color:#ff8a80">' + esc(s.error) + "</span>" : "") + "</div>" +
        '<div class="row">' +
          (paused ? '<button type="button" class="btn primary" data-act="resume">▶ Resume</button>' : '<button type="button" class="btn" data-act="pause">⏸ Pause</button>') +
          '<button type="button" class="btn" data-act="back">⏪ 10 min</button><button type="button" class="btn" data-act="fwd">10 min ⏩</button>' +
          '<input type="text" inputmode="numeric" placeholder="h:mm:ss" aria-label="Seek to" data-seek><button type="button" class="btn" data-act="seek">Seek</button>' +
          '<button type="button" class="btn danger" data-act="stop">⏹ Stop</button>' +
        "</div></div>";
    }).join("");
  }
  function refresh() {
    return api("GET", "/api/medialib/state").then(function (st) {
      defaultQuality = st.quality || 720;
      if (!st.configured) statusEl.textContent = "Not set up yet: the media-control service's address and secret go in the server's .env (MEDIACTL_URL, MEDIACTL_SECRET).";
      else if (!st.flag) statusEl.textContent = "Switched off - turn it on in /admin/media.";
      else if (!st.reachable) statusEl.textContent = "⚠ The media-control service can't be reached right now.";
      else statusEl.textContent = "Ready. " + ((st.sessions || []).length ? (st.sessions.length + " playing now.") : "Nothing playing.");
      drawNow(st);
      return st;
    }).catch(function (e) { statusEl.textContent = e.message; });
  }
  nowEl.addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-act]");
    if (!b) return;
    var card = b.closest(".ml-now"), r = card.getAttribute("data-room"), act = b.getAttribute("data-act");
    var cur = Number(card.getAttribute("data-pos")) || 0;
    var call;
    if (act === "stop") { if (!confirm("Stop it and end the library slot?")) return; call = api("POST", "/api/medialib/stop", { room: r }); }
    else if (act === "pause") call = api("POST", "/api/medialib/pause", { room: r });
    else if (act === "resume") call = api("POST", "/api/medialib/resume", { room: r });
    else if (act === "back" || act === "fwd") call = api("POST", "/api/medialib/seek", { room: r, offset: Math.max(0, cur + (act === "fwd" ? 600 : -600)) });
    else if (act === "seek") {
      var t = parseTime(card.querySelector("[data-seek]").value);
      if (t == null) { say("Type a time like 1:02:30."); return; }
      call = api("POST", "/api/medialib/seek", { room: r, offset: t });
    }
    b.disabled = true;
    say("Working…", true);
    call.then(function () { say("Done.", true); return refresh(); }).catch(function (e) { say(e.message); }).then(function () { b.disabled = false; });
  });

  // ── search + pick ──
  function card(it) {
    var sub = it.type === "episode" ? (esc(it.show) + " · S" + it.season + "E" + it.episode) : it.type === "show" ? "Show" + (it.leafs ? " · " + it.leafs + " episodes" : "") : (it.year || "Movie");
    return '<button type="button" class="ml-it" data-key="' + esc(it.key) + '">' +
      (it.poster ? '<img loading="lazy" alt="" src="/api/medialib/poster/' + encodeURIComponent(it.key) + '">' : '<span class="ml-ph"></span>') +
      "<b>" + esc(it.title) + "</b><small>" + sub + (it.duration ? " · " + hms(it.duration) : "") + "</small></button>";
  }
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var q = form.q.value.trim();
    if (q.length < 2) return;
    say("Searching…", true);
    pickEl.classList.add("hide");
    api("GET", "/api/medialib/search?q=" + encodeURIComponent(q)).then(function (j) {
      resultsEl.innerHTML = (j.results || []).map(card).join("") || '<p class="muted">Nothing found.</p>';
      say("");
    }).catch(function (e) { say(e.message); });
  });
  resultsEl.addEventListener("click", function (ev) {
    var b = ev.target.closest(".ml-it");
    if (b) openItem(b.getAttribute("data-key"));
  });
  pickEl.addEventListener("click", function (ev) {
    var ep = ev.target.closest("[data-ep]");
    if (ep) { openItem(ep.getAttribute("data-ep")); return; }
    var go = ev.target.closest("[data-play]");
    if (go) play(go);
  });
  function openItem(key) {
    say("Loading…", true);
    api("GET", "/api/medialib/item/" + encodeURIComponent(key)).then(function (j) {
      var it = j.item;
      picked = it;
      var h = "<div><b>" + esc(it.type === "episode" ? it.show + " · S" + it.season + "E" + it.episode + " · " + it.title : it.title) + "</b>" +
              (it.year ? " (" + it.year + ")" : "") + (it.duration ? ' <span class="muted">· ' + hms(it.duration) + "</span>" : "") + "</div>";
      if (it.summary) h += '<p class="muted" style="margin:0">' + esc(it.summary) + "</p>";
      if (it.type === "show") {
        h += '<div class="ml-eps">' + (it.episodes || []).map(function (e) {
          return '<button type="button" class="btn" data-ep="' + esc(e.key) + '">S' + e.season + "E" + e.episode + " · " + esc(e.title) + (e.duration ? ' <span class="muted">' + hms(e.duration) + "</span>" : "") + "</button>";
        }).join("") + "</div>";
      } else {
        var q = [1080, 720, 480].map(function (v) { return '<option value="' + v + '"' + (v === defaultQuality ? " selected" : "") + ">" + v + "p</option>"; }).join("");
        var au = (it.audio || []).map(function (a) { return '<option value="' + a.index + '"' + (a["default"] ? " selected" : "") + ">" + esc(a.label) + "</option>"; }).join("");
        var su = '<option value="">None</option>' + (it.subs || []).filter(function (s) { return s.burnable; }).map(function (s) {
          return '<option value="' + s.index + '">' + esc(s.label) + (s.forced ? " (forced)" : "") + "</option>";
        }).join("");
        h += '<div class="row">' +
          '<label>Quality <select data-q>' + q + "</select></label>" +
          (au ? '<label>Audio <select data-a>' + au + "</select></label>" : "") +
          '<label>Subtitles (burnt in) <select data-s>' + su + "</select></label>" +
          '<label>Start at <input type="text" data-o value="0:00" inputmode="numeric" style="width:90px"></label>' +
          "</div>" +
          '<div class="row"><button type="button" class="btn primary" data-play>▶ Play on ' + (fixedRoom ? "this pad's stage" : "the chosen pad") + "</button></div>" +
          (it.file ? '<p class="muted" style="margin:0">' + esc(String(it.file).split("/").pop()) + (it.hdr ? " · HDR → tone-mapped" : "") + "</p>" : "");
      }
      pickEl.innerHTML = h;
      pickEl.classList.remove("hide");
      say("");
      pickEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }).catch(function (e) { say(e.message); });
  }
  function play(btn) {
    if (!picked) return;
    var off = parseTime(pickEl.querySelector("[data-o]").value);
    var a = pickEl.querySelector("[data-a]"), s = pickEl.querySelector("[data-s]");
    var body = { room: room(), key: picked.key, quality: Number(pickEl.querySelector("[data-q]").value), offset: off || 0,
                 audio: a ? a.value : null, sub: s && s.value !== "" ? s.value : null };
    btn.disabled = true;
    say("Starting… (opening a library slot and the encoder)", true);
    api("POST", "/api/medialib/play", body).then(function (j) {
      say("▶ Playing " + j.title + ". It shows on the stage within a few seconds.", true);
      return refresh();
    }).catch(function (e) { say(e.message); }).then(function () { btn.disabled = false; });
  }
  if (roomSel) roomSel.addEventListener("change", refresh);
  refresh();
  setInterval(function () { if (!document.hidden) refresh(); }, 5000);
})();
