// public/js/media-admin.js — 1.99ji: /admin/media (mediaweb.js). Settings, connection checks, request links, the invite queue.
(function () {
  "use strict";
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
  function msg(id, t, good) { var e = document.getElementById(id); if (e) { e.textContent = t || ""; e.style.color = good ? "#9ccc65" : ""; } }

  // connection checks
  api("GET", "/api/media/admin/checks").then(function (j) {
    ["mediactl", "overseerr", "wizarr"].forEach(function (k) {
      var td = document.querySelector('[data-ck="' + k + '"]');
      if (!td) return;
      var c = j.checks[k];
      td.textContent = c == null ? "— (no keys)" : c.ok ? "✅" + (c.version ? " v" + c.version : "") + (c.streams != null ? " · " + c.streams + " streams" : "") : "⚠ " + (c.error || "no");
    });
  }).catch(function (e) { document.querySelectorAll("[data-ck]").forEach(function (td) { td.textContent = "⚠ " + e.message; }); });

  // settings
  var f = document.getElementById("mediaSettings");
  if (f) f.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var body = { _bools: String(f._bools.value).split(",") };
    Array.prototype.forEach.call(f.elements, function (el) {
      if (!el.name || el.name === "_bools") return;
      if (el.type === "checkbox") { if (el.checked) body[el.name] = true; }
      else body[el.name] = el.value;
    });
    msg("setMsg", "Saving…", true);
    api("POST", "/api/media/admin/settings", body).then(function (j) {
      msg("setMsg", "Saved" + (j.changed.length ? " (" + j.changed.join(", ") + ")" : " - nothing changed") +
        ". Live: library " + (j.on.library ? "on" : "off") + ", requests " + (j.on.requests ? "on" : "off") + ", invites " + (j.on.invites ? "on" : "off") + ".", true);
    }).catch(function (e) { msg("setMsg", e.message); });
  });

  var cat = document.getElementById("wzCat");
  if (cat) cat.addEventListener("click", function () {
    var out = document.getElementById("wzCatOut");
    out.textContent = "…";
    api("GET", "/api/media/admin/wizarr-catalog").then(function (j) {
      out.textContent = "Servers: " + (j.servers.map(function (s) { return s.id + " = " + s.name + (s.type ? " (" + s.type + ")" : ""); }).join(", ") || "none") +
        " · Libraries: " + (j.libraries.map(function (l) { return l.id + " = " + l.name; }).join(", ") || "none");
    }).catch(function (e) { out.textContent = e.message; });
  });

  var poll = document.getElementById("rqPoll");
  if (poll) poll.addEventListener("click", function () {
    msg("rqMsg", "Checking…", true);
    api("POST", "/api/media/admin/requests/poll").then(function (j) { msg("rqMsg", j.changed + " changed. Reload to see them.", true); })
      .catch(function (e) { msg("rqMsg", e.message); });
  });

  var lf = document.getElementById("linkForm");
  if (lf) lf.addEventListener("submit", function (ev) {
    ev.preventDefault();
    api("POST", "/api/media/admin/link", { username: lf.username.value, overseerr_user: lf.overseerr_user.value.trim() }).then(function (j) {
      msg("linkMsg", j.overseerr_user ? j.username + " → Overseerr user " + j.overseerr_user : j.username + " unlinked", true);
    }).catch(function (e) { msg("linkMsg", e.message); });
  });

  document.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-inv-act]");
    if (!b) return;
    var id = b.closest("[data-inv]").getAttribute("data-inv"), act = b.getAttribute("data-inv-act");
    var call;
    if (act === "retry") call = api("POST", "/api/media/admin/invites/" + encodeURIComponent(id) + "/retry");
    else {
      var t = prompt("Paste the invite link (or a note) you sent the buyer. It goes to their order page and a DM:");
      if (!t) return;
      call = api("POST", "/api/media/admin/invites/" + encodeURIComponent(id) + "/sent", { text: t });
    }
    b.disabled = true;
    call.then(function () { msg("invMsg", "Done - reload to refresh the queue.", true); }).catch(function (e) { msg("invMsg", e.message); })
      .then(function () { b.disabled = false; });
  });
})();
