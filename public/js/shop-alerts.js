// shop-alerts.js - 1.99tp: username suggestions for the "Alert on purchase" picker on /shop/admin/edit/<item>.
// 1.99ue: its own staff-only search (/api/shop/admin/people: username, display name AND linked Camfrog login, no length rule -
// the @mention suggest hid legacy usernames over 40 characters and never searched Camfrog logins). Each option's value is the
// PATV username; its label is "username · display · 🐸 login" so a long name is recognisable (and a typed login still matches).
(function () {
  "use strict";
  var dl = document.getElementById("saPeople"), last = "", tmr = null, seq = 0;
  if (!dl) return;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function label(p) {
    var parts = [p.username];
    if (p.display) parts.push(p.display);
    if (p.camfrog) parts.push("🐸 " + p.camfrog);
    return parts.join(" · ");
  }
  document.addEventListener("input", function (ev) {
    var x = ev.target;
    if (!x || x.getAttribute("list") !== "saPeople") return;
    var q = x.value.trim().replace(/^@/, "");
    clearTimeout(tmr);
    if (q.length < 2 || q === last) return;
    tmr = setTimeout(function () {
      last = q;
      var mine = ++seq;
      fetch("/api/shop/admin/people?q=" + encodeURIComponent(q), { headers: { "X-Requested-With": "fetch" }, credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (mine !== seq || !j || !j.people) return;          // a newer search is on its way
          dl.innerHTML = j.people.map(function (p) {
            var l = esc(label(p));
            return "<option value=\"" + esc(p.username) + "\" label=\"" + l + "\">" + l + "</option>";
          }).join("");
        })
        .catch(function () {});
    }, 200);
  });
})();
