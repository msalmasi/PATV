// admin-cosdrops.js — Phase 5 (5.17): the cosmetic drop table on /admin/cosmetics, plus the achievement counters' backend
// status. Reads /api/admin/cosmetic-drops and /api/admin/achievements-backend; edits POST back (admins, same site).
(function () {
  "use strict";
  var box = document.getElementById("cosDrops");
  if (!box) return;
  var achBox = document.getElementById("achBackend");
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  function post(body) {
    return fetch("/api/admin/cosmetic-drops", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
                                                 body: JSON.stringify(body) }).then(function (r) { return r.json(); });
  }
  var LABEL = { cap: "Daily cap per player (organic drops)", min_stake: "Minimum duel / brawl stake (PAT)", min_bj_bet: "Minimum blackjack bet (PAT)",
                min_holdem_pot: "Minimum hold'em pot (PAT)", min_level: "PvP: minimum level of both players", pair_rolls: "PvP: rolls per pair per day",
                event_pool_share: "Share of an event's drops from its own items (0-1)" };
  function render(d) {
    box.textContent = "";
    var head = el("p", { class: "adm-help" });
    head.textContent = d.live
      ? "The site owns the drop table: these numbers are used for every drop - Pepe's Camfrog events (he reads them every 5 minutes) and the site's own (the wheel, the casino tables)."
      : "The drop table still lives on Pepe (his panel's drop knobs; he pushes the wheel and casino rows here). Pepe hands it over with !cosmetics backend on confirm" +
        (d.enabled ? " (allowed on this site)." : " - allow it first:");
    box.appendChild(head);
    if (!d.live) {
      var b = el("button", { type: "button", class: "adm-btn ghost" }, d.enabled ? "Don't allow the hand-over" : "Allow the hand-over");
      b.addEventListener("click", function () { post({ switch: !d.enabled }).then(load); });
      box.appendChild(b);
    }
    var form = el("form", { class: "adm-form" });
    var keys = d.rates.concat(d.params);
    keys.forEach(function (k) {
      var lab = el("label", { for: "cd_" + k });
      var isRate = d.rates.indexOf(k) >= 0;
      lab.textContent = isRate ? ("Drop chance: " + k.replace(/_/g, " ") + (d.organic.indexOf(k) >= 0 ? " (counts toward the cap)" : "")) : (LABEL[k] || k);
      var inp = el("input", { type: "number", id: "cd_" + k, name: k, step: isRate || k === "event_pool_share" ? "0.0001" : "1", min: "0" });
      inp.value = d.config[k];
      if (!d.live) inp.disabled = true;
      var hint = el("small", { class: "adm-help" }, "default " + d.defaults[k]);
      lab.appendChild(inp);
      lab.appendChild(hint);
      form.appendChild(lab);
    });
    var actions = el("div", { class: "adm-actions" });
    var save = el("button", { type: "submit" }, "Save the drop table");
    var msg = el("span", { class: "adm-msg", role: "status" });
    if (!d.live) save.disabled = true;
    actions.appendChild(save);
    actions.appendChild(msg);
    form.appendChild(actions);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var values = {};
      keys.forEach(function (k) { values[k] = Number(form.elements[k].value); });
      post({ values: values }).then(function (r) {
        msg.textContent = r.ok ? ("Saved" + (Object.keys(r.changed || {}).length ? ": " + Object.keys(r.changed).join(", ") : " (no change)")) : (r.error || "Not saved");
        if (r.ok) setTimeout(load, 600);
      });
    });
    box.appendChild(form);
    if (d.log && d.log.length) {
      var det = el("details", { class: "adm-adv" });
      det.appendChild(el("summary", null, "Changes"));
      var ul = el("ul");
      d.log.forEach(function (x) {
        ul.appendChild(el("li", null, new Date(x.at).toISOString().slice(0, 16).replace("T", " ") + " · " + (x.by || "") + " · " + x.what +
                                       (x.changed ? " " + JSON.stringify(x.changed) : "")));
      });
      det.appendChild(ul);
      box.appendChild(det);
    }
  }
  function load() {
    fetch("/api/admin/cosmetic-drops").then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { box.textContent = d.error || "Couldn't read the drop table."; return; }
      render(d);
    }).catch(function () { box.textContent = "Couldn't read the drop table."; });
    if (achBox) {
      fetch("/api/admin/achievements-backend").then(function (r) { return r.json(); }).then(function (a) {
        if (!a.ok) { achBox.textContent = a.error || ""; return; }
        var t = a.totals || {};
        achBox.textContent = a.live
          ? ("The achievement counters live on the site: " + (t.users || 0).toLocaleString() + " people, " + (t.got || 0).toLocaleString() +
             " unlocks, " + (a.events || 0).toLocaleString() + " events from Pepe" + (a.last_event ? " (last " + new Date(a.last_event).toISOString().slice(0, 16).replace("T", " ") + " UTC)" : "") + ".")
          : ("The achievement counters still live on Pepe (achievements_progress.json)" + (a.enabled ? "; the hand-over is allowed here." : "; the hand-over is not allowed here yet."));
      }).catch(function () {});
    }
  }
  load();
})();
