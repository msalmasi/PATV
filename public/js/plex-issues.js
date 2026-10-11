// public/js/plex-issues.js — 1.99la: 🛠️ Report a problem on /plex (mediaissues.js). Find a title that's on our Plex
// server (search, recently added, or "Report a problem" on one of your requests), say what's wrong, send it to Seerr.
// Lists your reports with their status and the comments.
(function () {
  "use strict";
  var root = document.getElementById("pxi");
  if (!root) return;
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var form = document.getElementById("pxiForm"), list = document.getElementById("pxiList"), listH = document.getElementById("pxiListH");
  var pick = document.getElementById("pxiPick"), msgEl = document.getElementById("pxiMsg"), mineEl = document.getElementById("pxiMine");
  var cur = null;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function say(t, good) { msgEl.textContent = t || ""; msgEl.style.color = good ? "#a5d6a7" : (t ? "#ffb4b4" : ""); }
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
  function poster(x) {
    return x.poster_url ? '<img loading="lazy" alt="" referrerpolicy="no-referrer" src="' + esc(x.poster_url) + '">'
      : '<span class="pxi-ph" aria-hidden="true">' + (x.type === "tv" ? "📺" : "🎬") + "</span>";
  }
  function fixImages(el) {
    Array.prototype.forEach.call(el.querySelectorAll("img"), function (im) {
      im.addEventListener("error", function () {
        var s = document.createElement("span"); s.className = "pxi-ph"; s.textContent = "🎬"; im.replaceWith(s);
      }, { once: true });
    });
  }
  function show(items, empty) {
    list.innerHTML = (items || []).map(function (x) {
      return '<button type="button" class="pxi-it" data-type="' + esc(x.type) + '" data-tmdb="' + esc(x.tmdb) + '" data-title="' + esc(x.title) + '">' + poster(x) +
        "<b>" + esc(x.title) + "</b><small>" + (x.type === "tv" ? _t('js.pxi.show', 'Show') : _t('js.pxi.movie', 'Movie')) + (x.year ? " · " + esc(x.year) : "") +
        (x.partial ? " · " + _t('js.pxi.partial', 'Partly on Plex') : "") + "</small></button>";
    }).join("") || '<p class="mut">' + esc(empty) + "</p>";
    fixImages(list);
  }
  function openForm(type, tmdb, title) {
    cur = { type: type, tmdb: tmdb, title: title };
    var h = "<div><b>" + esc(title) + "</b></div>" +
      '<div class="row"><label>' + _t('js.pxi.type', 'What’s wrong?') + ' <select name="issue_type" required>' +
      '<option value="video">' + _t('js.pxi.t_video', 'Video') + "</option>" +
      '<option value="audio">' + _t('js.pxi.t_audio', 'Audio') + "</option>" +
      '<option value="subtitles">' + _t('js.pxi.t_subtitles', 'Subtitles') + "</option>" +
      '<option value="other">' + _t('js.pxi.t_other', 'Other') + "</option></select></label></div>";
    if (type === "tv") {
      h += '<div class="row"><label>' + _t('js.pxi.season', 'Season (optional)') + ' <input type="number" name="season" min="1" max="999" inputmode="numeric" style="width:6em"></label>' +
        '<label>' + _t('js.pxi.episode', 'Episode (optional)') + ' <input type="number" name="episode" min="1" max="9999" inputmode="numeric" style="width:6em"></label></div>';
    }
    h += '<textarea name="message" minlength="5" maxlength="1000" required placeholder="' + esc(_t('js.pxi.msg_ph', 'Describe the problem: what you see or hear, and where')) + '"></textarea>' +
      '<div class="row"><button type="submit" class="pri">' + _t('js.pxi.send', 'Send report') + '</button><button type="button" data-cancel>' + _t('js.pxi.cancel', 'Cancel') + "</button></div>";
    pick.innerHTML = h;
    pick.hidden = false;
    say("");
    pick.scrollIntoView({ block: "nearest", behavior: "smooth" });
    var ta = pick.querySelector("textarea"); if (ta) ta.focus();
  }
  function loadRecent() {
    api("GET", "/api/plex/library/recent").then(function (j) {
      listH.textContent = _t('js.pxi.recent', 'Recently added');
      show(j.results, _t('js.pxi.none', 'Nothing on our Plex server matches that.'));
    }).catch(function () { list.innerHTML = ""; });
  }
  var ST = { open: function () { return _t('js.pxi.st_open', 'Open'); }, resolved: function () { return _t('js.pxi.st_resolved', 'Resolved'); },
             removed: function () { return _t('js.pxi.st_removed', 'Removed'); } };
  var TY = { video: function () { return _t('js.pxi.t_video', 'Video'); }, audio: function () { return _t('js.pxi.t_audio', 'Audio'); },
             subtitles: function () { return _t('js.pxi.t_subtitles', 'Subtitles'); }, other: function () { return _t('js.pxi.t_other', 'Other'); } };
  function loadMine() {
    api("GET", "/api/plex/issues/mine").then(function (j) {
      mineEl.innerHTML = (j.issues || []).map(function (x) {
        var where = x.season ? " · S" + esc(x.season) + (x.episode ? " E" + esc(x.episode) : "") : "";
        return '<li data-id="' + esc(x.id) + '"><b>' + esc(x.title) + "</b>" + (x.year ? " (" + esc(x.year) + ")" : "") +
          ' <span class="pill st-' + (x.status === "resolved" ? "available" : x.status === "removed" ? "removed" : "pending") + '">' + (ST[x.status] ? ST[x.status]() : esc(x.status)) + "</span>" +
          ' <span class="mut">· ' + (TY[x.issue_type] ? TY[x.issue_type]() : esc(x.issue_type)) + where + " · " + esc(new Date(x.created).toLocaleDateString()) + "</span>" +
          '<div class="pxi-cm">' + esc(x.message) + "</div>" +
          (x.comments || []).slice(1).map(function (c) { return '<div class="pxi-cm">💬 <b>' + esc(c.by) + "</b>: " + esc(c.message) + "</div>"; }).join("") +
          (x.status === "open" && x.seerr_id ? '<form class="pxi-search" data-comment style="margin-top:6px"><input name="m" maxlength="1000" placeholder="' + esc(_t('js.pxi.comment_ph', 'Add a comment')) + '"><button type="submit">' + _t('js.pxi.comment', 'Comment') + "</button></form>" : "") +
          "</li>";
      }).join("") || '<li class="mut">' + _t('js.pxi.no_reports', 'You haven’t reported anything.') + "</li>";
    }).catch(function (e) { mineEl.innerHTML = '<li class="mut">' + esc(e.message) + "</li>"; });
  }
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var q = form.q.value.trim();
    if (q.length < 2) return;
    say(_t('js.pxi.searching', 'Searching…'), true);
    api("GET", "/api/plex/library/search?q=" + encodeURIComponent(q)).then(function (j) {
      listH.textContent = _t('js.pxi.results', 'On our Plex server');
      show(j.results, _t('js.pxi.none', 'Nothing on our Plex server matches that.'));
      say("");
    }).catch(function (e) { say(e.message); });
  });
  list.addEventListener("click", function (ev) {
    var b = ev.target.closest(".pxi-it");
    if (b) openForm(b.getAttribute("data-type"), b.getAttribute("data-tmdb"), b.getAttribute("data-title"));
  });
  document.addEventListener("click", function (ev) {
    var a = ev.target.closest("[data-pxi-report]");
    if (!a) return;
    ev.preventDefault();
    var p = a.getAttribute("data-pxi-report").split(":");
    openForm(p[0], p[1], a.getAttribute("data-pxi-title") || "");
  });
  pick.addEventListener("click", function (ev) {
    if (ev.target.closest("[data-cancel]")) { pick.hidden = true; pick.innerHTML = ""; cur = null; say(""); }
  });
  pick.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!cur) return;
    var body = { type: cur.type, tmdb: cur.tmdb, issue_type: pick.issue_type.value, message: pick.message.value };
    if (pick.season) { body.season = pick.season.value; body.episode = pick.episode.value; }
    var btn = pick.querySelector("button[type=submit]");
    btn.disabled = true;
    say(_t('js.pxi.sending', 'Sending…'), true);
    api("POST", "/api/plex/issues", body).then(function (j) {
      say(j.dry ? _t('js.pxi.sent_dry', 'Saved (staging: not sent to the request server).') : _t('js.pxi.sent', 'Thanks, your report was sent.'), true);
      pick.hidden = true; pick.innerHTML = ""; cur = null;
      loadMine();
    }).catch(function (e) { say(e.message); btn.disabled = false; });
  });
  mineEl.addEventListener("submit", function (ev) {
    var f = ev.target.closest("[data-comment]");
    if (!f) return;
    ev.preventDefault();
    var li = f.closest("li"), m = f.m.value.trim();
    if (m.length < 2) return;
    f.querySelector("button").disabled = true;
    api("POST", "/api/plex/issues/" + encodeURIComponent(li.getAttribute("data-id")) + "/comment", { message: m }).then(function () { loadMine(); })
      .catch(function (e) { say(e.message); f.querySelector("button").disabled = false; });
  });
  loadRecent();
  loadMine();
  if (location.hash === "#issues") root.scrollIntoView();
})();
