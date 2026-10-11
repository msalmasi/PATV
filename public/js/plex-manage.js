// public/js/plex-manage.js — 1.99la: /plex/manage (mediaissues.js) - every Seerr request (approve / decline) and every
// reported problem (resolve / reopen / comment). The server checks the curator role on every call.
(function () {
  "use strict";
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var msgEl = document.getElementById("pmMsg");
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
  function img(x) {
    return x.poster_url ? '<img loading="lazy" alt="" referrerpolicy="no-referrer" src="' + esc(x.poster_url) + '">' : '<span class="ph" aria-hidden="true">' + (x.type === "tv" ? "📺" : "🎬") + "</span>";
  }
  function fixImages(el) {
    Array.prototype.forEach.call(el.querySelectorAll("img"), function (im) {
      im.addEventListener("error", function () { var s = document.createElement("span"); s.className = "ph"; s.textContent = "🎬"; im.replaceWith(s); }, { once: true });
    });
  }
  function when(ms) { return ms ? new Date(ms).toLocaleDateString() : ""; }
  var RS = { pending: function () { return _t('js.pxm.st_pending', 'Waiting for approval'); }, approved: function () { return _t('js.pxm.st_approved', 'Approved'); },
             declined: function () { return _t('js.pxm.st_declined', 'Declined'); }, failed: function () { return _t('js.pxm.st_failed', 'Failed'); },
             completed: function () { return _t('js.pxm.st_completed', 'Completed'); } };
  var TY = { video: function () { return _t('js.pxi.t_video', 'Video'); }, audio: function () { return _t('js.pxi.t_audio', 'Audio'); },
             subtitles: function () { return _t('js.pxi.t_subtitles', 'Subtitles'); }, other: function () { return _t('js.pxi.t_other', 'Other'); } };
  function pager(el, st, load) {
    el.innerHTML = (st.page > 1 ? '<button type="button" data-p="' + (st.page - 1) + '">' + _t('js.pxm.prev', 'Previous') + "</button>" : "") +
      (st.page < st.pages ? '<button type="button" data-p="' + (st.page + 1) + '">' + _t('js.pxm.next', 'Next') + "</button>" : "");
    el.onclick = function (ev) { var b = ev.target.closest("[data-p]"); if (b) load(st.filter, Number(b.getAttribute("data-p"))); };
  }
  function tabs(id, load) {
    var el = document.getElementById(id);
    el.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-f]");
      if (!b) return;
      Array.prototype.forEach.call(el.querySelectorAll("[data-f]"), function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
      load(b.getAttribute("data-f"), 1);
    });
  }

  // ── requests ──
  var reqEl = document.getElementById("pmReq"), reqSt = { filter: "pending", page: 1, pages: 1 };
  function loadReq(f, p) {
    reqSt.filter = f; reqSt.page = p;
    api("GET", "/api/plex/manage/requests?filter=" + encodeURIComponent(f) + "&page=" + p).then(function (j) {
      reqSt.pages = j.pages || 1;
      reqEl.innerHTML = (j.requests || []).map(function (x) {
        return '<li data-id="' + esc(x.id) + '">' + img(x) + '<div class="w"><b>' + esc(x.title) + "</b>" + (x.year ? " (" + esc(x.year) + ")" : "") +
          (x.seasons && x.seasons.length ? ' <span class="mut">S' + x.seasons.map(esc).join(", S") + "</span>" : "") +
          ' <span class="pill">' + (RS[x.status] ? RS[x.status]() : esc(x.status)) + "</span>" +
          '<div class="mut">' + esc(_t('js.pxm.by', 'by {name}', { name: x.by })) + (x.patv ? " · " + esc(_t('js.pxm.on_patv', 'PATV: {name}', { name: x.patv })) : "") + " · " + esc(when(x.created)) + "</div>" +
          (x.status === "pending" ? '<div class="acts"><button type="button" class="ok" data-v="approve">' + _t('js.pxm.approve', 'Approve') + '</button><button type="button" class="no" data-v="decline">' + _t('js.pxm.decline', 'Decline') + "</button></div>" : "") +
          "</div></li>";
      }).join("") || '<li class="mut">' + _t('js.pxm.none', 'Nothing here.') + "</li>";
      fixImages(reqEl);
      pager(document.getElementById("pmReqPager"), reqSt, loadReq);
    }).catch(function (e) { reqEl.innerHTML = '<li class="mut">' + esc(e.message) + "</li>"; });
  }
  reqEl.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-v]");
    if (!b) return;
    var v = b.getAttribute("data-v"), li = b.closest("li");
    if (v === "decline" && !window.confirm(_t('js.pxm.confirm_decline', 'Decline this request?'))) return;
    b.disabled = true;
    api("POST", "/api/plex/manage/requests/" + encodeURIComponent(li.getAttribute("data-id")) + "/" + v).then(function (j) {
      say(j.dry ? _t('js.pxm.dry', 'Staging: nothing was sent.') : _t('js.pxm.done', 'Done.'), true);
      loadReq(reqSt.filter, reqSt.page);
    }).catch(function (e) { say(e.message); b.disabled = false; });
  });
  tabs("pmReqTabs", loadReq);

  // ── issues ──
  var issEl = document.getElementById("pmIss"), issSt = { filter: "open", page: 1, pages: 1 };
  function loadIss(f, p) {
    issSt.filter = f; issSt.page = p;
    api("GET", "/api/plex/manage/issues?filter=" + encodeURIComponent(f) + "&page=" + p).then(function (j) {
      issSt.pages = j.pages || 1;
      issEl.innerHTML = (j.issues || []).map(function (x) {
        var where = x.season ? " · S" + esc(x.season) + (x.episode ? " E" + esc(x.episode) : "") : "";
        return '<li data-id="' + esc(x.id) + '">' + img(x) + '<div class="w"><b>' + esc(x.title) + "</b>" + (x.year ? " (" + esc(x.year) + ")" : "") +
          ' <span class="pill">' + (x.status === "resolved" ? _t('js.pxi.st_resolved', 'Resolved') : _t('js.pxi.st_open', 'Open')) + "</span>" +
          '<div class="mut">' + (TY[x.issue_type] ? TY[x.issue_type]() : esc(x.issue_type)) + where + " · " + esc(_t('js.pxm.by', 'by {name}', { name: x.by })) +
          (x.patv ? " · " + esc(_t('js.pxm.on_patv', 'PATV: {name}', { name: x.patv })) : "") + " · " + esc(when(x.created)) + "</div>" +
          (x.comments || []).map(function (c) { return '<div class="cm">💬 <b>' + esc(c.by) + "</b>: " + esc(c.message) + "</div>"; }).join("") +
          '<div class="acts">' + (x.status === "resolved" ? '<button type="button" data-s="open">' + _t('js.pxm.reopen', 'Reopen') + "</button>"
            : '<button type="button" class="ok" data-s="resolved">' + _t('js.pxm.resolve', 'Resolve') + "</button>") + "</div>" +
          '<form class="cform"><input name="m" maxlength="1000" placeholder="' + esc(_t('js.pxi.comment_ph', 'Add a comment')) + '"><button type="submit">' + _t('js.pxi.comment', 'Comment') + "</button></form>" +
          "</div></li>";
      }).join("") || '<li class="mut">' + _t('js.pxm.none', 'Nothing here.') + "</li>";
      fixImages(issEl);
      pager(document.getElementById("pmIssPager"), issSt, loadIss);
    }).catch(function (e) { issEl.innerHTML = '<li class="mut">' + esc(e.message) + "</li>"; });
  }
  issEl.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-s]");
    if (!b) return;
    var li = b.closest("li");
    b.disabled = true;
    api("POST", "/api/plex/manage/issues/" + encodeURIComponent(li.getAttribute("data-id")) + "/" + b.getAttribute("data-s")).then(function (j) {
      say(j.dry ? _t('js.pxm.dry', 'Staging: nothing was sent.') : _t('js.pxm.done', 'Done.'), true);
      loadIss(issSt.filter, issSt.page);
    }).catch(function (e) { say(e.message); b.disabled = false; });
  });
  issEl.addEventListener("submit", function (ev) {
    var f = ev.target.closest(".cform");
    if (!f) return;
    ev.preventDefault();
    var m = f.m.value.trim(), li = f.closest("li");
    if (m.length < 2) return;
    f.querySelector("button").disabled = true;
    api("POST", "/api/plex/manage/issues/" + encodeURIComponent(li.getAttribute("data-id")) + "/comment", { message: m }).then(function () {
      say(_t('js.pxm.done', 'Done.'), true); loadIss(issSt.filter, issSt.page);
    }).catch(function (e) { say(e.message); f.querySelector("button").disabled = false; });
  });
  tabs("pmIssTabs", loadIss);

  loadReq("pending", 1);
  loadIss("open", 1);
})();
