// public/js/request-roles-admin.js — 1.99la: /admin/media/roles (requestroles.js). Admin-only page, English.
(function () {
  "use strict";
  var root = document.getElementById("rrAdm");
  if (!root) return;
  var msg = document.getElementById("rrMsg");
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
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
  function done(t) { msg.textContent = t; setTimeout(function () { location.reload(); }, 900); }
  root.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-act]");
    if (!b) return;
    var tr = b.closest("tr"), u = tr.getAttribute("data-u"), r = tr.getAttribute("data-r"), act = b.getAttribute("data-act");
    var body = { username: u, role: r };
    if (act === "revoke") {
      var why = window.prompt("Revoke " + r + " from " + u + "? It takes back the Seerr permissions PATV added and the Discord role (if PATV gave it). Reason:");
      if (why == null) return;
      body.reason = why;
    }
    b.disabled = true;
    api("POST", "/api/media/admin/roles/" + act, body).then(function () { done("Done."); })
      .catch(function (e) { msg.textContent = e.message; b.disabled = false; });
  });
  document.getElementById("rrAdd").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var f = ev.target;
    api("POST", "/api/media/admin/roles/grant", { username: f.username.value.trim(), role: f.role.value }).then(function () { done("Granted."); })
      .catch(function (e) { msg.textContent = e.message; });
  });
  document.getElementById("rrAudit").addEventListener("click", function (ev) {
    var b = ev.target, out = document.getElementById("rrAuditOut");
    b.disabled = true;
    out.textContent = "Asking Discord, the store and Seerr…";
    api("GET", "/api/media/admin/roles/audit").then(function (j) {
      var names = function (a, f) { return (a || []).map(f).join(", ") || "—"; };
      out.innerHTML = Object.keys(j.audit).map(function (role) {
        var a = j.audit[role];
        var held = {};
        (a.discord || []).forEach(function (d) { if (d.username) held[d.username] = (held[d.username] || "") + "D"; });
        (a.orders || []).forEach(function (o) { if (o.username) held[o.username] = (held[o.username] || "") + "O"; });
        (a.active || []).forEach(function (x) { if (x.username) held[x.username] = (held[x.username] || "") + "A"; });
        var mism = Object.keys(held).filter(function (k) { return held[k].indexOf("D") < 0 || held[k].indexOf("O") < 0 && held[k].indexOf("A") < 0; });
        return "<h3>" + esc(role) + "</h3><ul>" +
          "<li><b>Discord role</b>: " + (a.discordError ? "<i>" + esc(a.discordError) + "</i>" : names(a.discord, function (d) { return d.username ? esc(d.username) : "unlinked Discord user …" + esc(d.discordTail); })) + "</li>" +
          "<li><b>PATV store orders</b>: " + names(a.orders, function (o) { return esc(o.username) + " ×" + o.n; }) + "</li>" +
          "<li><b>PATV store records (user_roles)</b>: " + names(a.owned, function (o) { return esc(o.username) + " (" + esc(o.source) + ")"; }) + "</li>" +
          "<li><b>Active here</b>: " + names(a.active, function (x) { return esc(x.username) + " [Seerr " + esc(x.seerr_state) + "]"; }) + "</li>" +
          "<li><b>Seerr users that already look like holders</b>: " + (a.seerr ? names(a.seerr, function (s) { return esc(s.name) + " #" + s.id + (s.has ? " (" + esc(s.has) + ")" : ""); }) : "<i>Seerr not reachable</i>") + "</li>" +
          "<li><b>Mismatches</b> (Discord role without an order/activation, or the reverse): " + (mism.map(function (k) { return esc(k) + " [" + held[k] + "]"; }).join(", ") || "none") + "</li></ul>";
      }).join("") + '<p class="muted">D = Discord role, O = store order, A = active here. Nothing was changed; Discord roles are never removed by this page.</p>';
      b.disabled = false;
    }).catch(function (e) { out.textContent = e.message; b.disabled = false; });
  });
})();
