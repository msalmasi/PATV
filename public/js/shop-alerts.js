// shop-alerts.js - 1.99tp: username suggestions for the "Alert on purchase" picker on /shop/admin/edit/<item>
// (the same people search as @mentions; a Camfrog login works too - the server falls back to it).
(function () {
  "use strict";
  var dl = document.getElementById("saPeople"), last = "", tmr = null;
  if (!dl) return;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  document.addEventListener("input", function (ev) {
    var x = ev.target;
    if (!x || x.getAttribute("list") !== "saPeople") return;
    var q = x.value.trim().replace(/^@/, "");
    clearTimeout(tmr);
    if (q.length < 2 || q === last) return;
    tmr = setTimeout(function () {
      last = q;
      fetch("/api/mentions/suggest?q=" + encodeURIComponent(q), { headers: { "X-Requested-With": "fetch" }, credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j && j.people) dl.innerHTML = j.people.map(function (p) { return "<option value=\"" + esc(p.username) + "\">" + esc(p.display || "") + "</option>"; }).join(""); })
        .catch(function () {});
    }, 200);
  });
})();
