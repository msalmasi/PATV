// public/js/admin-comps.js - 1.99ma: /admin/comps (comps.js). Renders the lists from the page's JSON and posts the forms.
(function () {
  "use strict";
  var el = document.getElementById("compsData");
  if (!el) return;
  var C = {};
  try { C = JSON.parse(el.textContent || "{}"); } catch (e) { C = {}; }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function day(t) { return t ? new Date(Number(t)).toISOString().slice(0, 10) : ""; }
  function when(t) { return t ? new Date(Number(t)).toISOString().slice(0, 16).replace("T", " ") : ""; }
  function post(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }); });
  }
  function say(node, text, ok) { if (!node) return; node.textContent = text; node.className = "adm-msg " + (ok ? "ok" : "err"); }
  function formData(f) {
    var o = {};
    Array.prototype.forEach.call(f.elements, function (x) { if (x.name) o[x.name] = x.value.trim(); });
    return o;
  }

  // ── lists ──
  function render() {
    var t = Date.now();
    var pr = document.getElementById("plexRows");
    var rows = (C.plex || []).filter(function (c) { return c.active; });
    pr.innerHTML = rows.length ? rows.map(function (c) {
      return "<tr><td><a href=\"/u/" + encodeURIComponent(c.username || "") + "\">" + esc(c.username || c.user_id) + "</a></td>" +
        "<td>" + (c.kind === "lifetime" ? "Lifetime" : "Trial · " + esc(c.days) + " d") + "</td>" +
        "<td>" + (c.kind === "lifetime" ? "no end date" : esc(day(c.until))) + "</td>" +
        "<td>" + (c.delivery === "invite" ? (c.order_id ? "<a href=\"/shop/orders/" + c.order_id + "\">invite (order #" + c.order_id + ")</a>" : "invite") : "added to their access") + "</td>" +
        "<td>" + esc(c.by_name) + " · " + esc(c.reason) + "</td>" +
        "<td>" + (c.kind === "lifetime" ? "" : "<button type=\"button\" data-px=\"" + c.id + "\">Extend</button> ") +
        "<button type=\"button\" class=\"adm-btn danger\" data-pr=\"" + c.id + "\">Revoke</button></td></tr>";
    }).join("") : "<tr><td class=\"empty\" colspan=\"6\">No active Plex comps.</td></tr>";
    var mr = document.getElementById("premRows");
    var prem = (C.premium || []).filter(function (s) { return !s.ended; });
    mr.innerHTML = prem.length ? prem.map(function (s) {
      var data = " data-tier=\"" + esc(s.tier) + "\" data-target=\"" + esc(s.target) + "\"";
      return "<tr><td>" + ({ prime_time: "📺 Prime Time", prime_plus: "💎 Prime Time Plus" }[s.tier] || "🎟️ Season Pass") + "</td><td>" + esc(s.label) + "</td>" +
        "<td>" + (s.until ? esc(day(s.until)) : "no end date") + "</td><td>" + (s.auto ? "auto (site admin)" : esc(s.by) + (s.note ? " · " + esc(s.note) : "")) + "</td>" +
        "<td>" + (s.auto ? "" : (s.until ? "<button type=\"button\" data-mx" + data + ">Extend</button> " : "") + "<button type=\"button\" class=\"adm-btn danger\" data-mr" + data + ">Revoke</button>") + "</td></tr>";
    }).join("") : "<tr><td class=\"empty\" colspan=\"5\">No premium comps.</td></tr>";
    var pol = document.getElementById("polRows");
    pol.innerHTML = (C.items || []).map(function (p) {
      return "<tr><td><a href=\"/shop/item/" + encodeURIComponent(p.prizeId) + "\">" + esc(p.prize) + "</a></td><td>" + esc(p.kind) + "</td>" +
        "<td>" + (p.giftable ? "✅" : "—") + "</td><td>" + (p.compable ? "✅" : "—") + "</td><td>" + esc(p.why || "") + "</td></tr>";
    }).join("") || "<tr><td class=\"empty\" colspan=\"5\">No official items.</td></tr>";
    var lg = document.getElementById("logRows");
    lg.innerHTML = (C.recent || []).map(function (r) {
      return "<tr><td>" + esc(when(r.at)) + "</td><td>" + esc(r.admin_name) + "</td><td>" + esc(r.action) + "</td><td>" + esc(r.target_name || "") + "</td>" +
        "<td><code>" + esc(r.detail ? JSON.stringify(r.detail).slice(0, 160) : "") + "</code></td><td>" + esc(r.reason || "") + "</td></tr>";
    }).join("") || "<tr><td class=\"empty\" colspan=\"6\">Nothing yet.</td></tr>";
    var gr = document.getElementById("giftRows");          // 1.99mt: the gift log (real givers)
    if (gr) gr.innerHTML = (C.gifts || []).map(function (g) {
      var who = function (n) { return n ? "<a href=\"/u/" + encodeURIComponent(n) + "\">" + esc(n) + "</a>" : "—"; };
      return "<tr><td>" + esc(when(g.created)) + "</td><td>" + esc(g.kind) + "</td><td>" + esc(g.item || "") + "</td><td>" + who(g.giver) + "</td>" +
        "<td>" + (g.recipient ? who(g.recipient) : esc(g.target || "—")) + "</td><td>" + (g.anon ? "🕶 yes" : "") + "</td></tr>";
    }).join("") || "<tr><td class=\"empty\" colspan=\"6\">No gifts yet.</td></tr>";
    fillItems();
    void t;
  }
  var itemForm = document.getElementById("itemForm");
  function fillItems() {
    if (!itemForm) return;
    var kind = itemForm.elements.kind.value, sel = itemForm.querySelector("[data-items]"), keep = sel.value;
    var list = kind === "cosmetic" ? (C.cosmetics || []).map(function (c) { return [c.id, c.name + " (" + c.kind + ")"]; })
      : kind === "sticker" ? (C.stickers || []).map(function (s) { return [s.id, s.name]; })
      : (C.items || []).filter(function (p) { return p.compable; }).map(function (p) { return [p.prizeId, p.prize]; });
    sel.innerHTML = list.map(function (x) { return "<option value=\"" + esc(x[0]) + "\">" + esc(x[1]) + "</option>"; }).join("");
    if (keep) sel.value = keep;
  }

  function after(j, msg, okText) {
    if (j && j.ok) { if (j.state) C = j.state; render(); say(msg, okText || "Done.", true); return true; }
    say(msg, (j && j.error) || "Failed.", false);
    padPicks(msg, j);
    return false;
  }
  // 1.99od: an unknown pad -> its "did you mean" list as buttons that fill the Pad field (the server accepts the slug,
  // p/slug, a link, the Camfrog room id or the title)
  function padPicks(msg, j) {
    if (!msg || !j || !j.suggestions || !j.suggestions.length) return;
    var f = msg.closest("form"), field = f && f.elements.pad;
    if (!field) return;
    var box = document.createElement("span");
    box.className = "adm-picks";
    j.suggestions.forEach(function (x) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "adm-btn";
      b.textContent = (x.title && x.title !== x.slug ? x.title + " · " : "") + "p/" + x.slug;
      b.addEventListener("click", function () { field.value = x.slug; say(msg, "Pad set to p/" + x.slug + " - press Comp it.", true); field.focus(); });
      box.appendChild(document.createTextNode(" "));
      box.appendChild(b);
    });
    msg.appendChild(box);
  }

  // ── forms ──
  function bind(id, url, okText, shape) {
    var f = document.getElementById(id);
    if (!f) return;
    f.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var b = formData(f), msg = f.querySelector("[data-msg]");
      if (shape) b = shape(b);
      var btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      post(url, b).then(function (j) { if (after(j, msg, typeof okText === "function" ? okText(j) : okText) && f.elements.reason) f.elements.reason.value = ""; })
        .catch(function () { say(msg, "Couldn't reach the server.", false); })
        .then(function () { btn.disabled = false; });
    });
  }
  bind("plexForm", "/api/admin/comps/plex", function (j) {
    var r = j && j.result || {};
    return r.delivery === "invite" ? "Comped - " + (r.invite && r.invite.ok ? "the invite went out." : "the invite is in the manual queue.") : "Comped - added to their Plex access.";
  });
  bind("setForm", "/api/admin/comps/settings", "Saved.");
  bind("premForm", "/api/admin/comps/premium", function (j) { var r = j && j.result || {}; return "Comped " + (r.label || "") + (r.until ? " until " + day(r.until) : " with no end date") + "."; },
    function (b) { if (b.tier === "prime_time" || b.tier === "prime_plus") delete b.user; else delete b.pad; return b; });
  bind("itemForm", "/api/admin/comps/item", function (j) { var r = j && j.result || {}; return "Comped " + (r.prize || r.item || "it") + (r.to ? " to " + r.to : "") + "."; });

  var pf = document.getElementById("plexForm");
  function plexKind() { var tr = pf.querySelector("[data-trial]"); tr.hidden = pf.elements.kind.value !== "trial"; }
  if (pf) { pf.elements.kind.addEventListener("change", plexKind); plexKind(); }
  var mf = document.getElementById("premForm");
  function premShape() {
    var tier = mf.elements.tier.value;
    mf.querySelectorAll("[data-for]").forEach(function (l) { l.hidden = l.getAttribute("data-for").split(" ").indexOf(tier) < 0; });   // 1.99qp: "prime_time prime_plus"
    mf.querySelector("[data-n]").hidden = mf.elements.mode.value === "lifetime";
  }
  if (mf) { mf.elements.tier.addEventListener("change", premShape); mf.elements.mode.addEventListener("change", premShape); premShape(); }
  if (itemForm) itemForm.elements.kind.addEventListener("change", function () { itemForm.querySelector("[data-items]").value = ""; fillItems(); });

  // ── row buttons ──
  var actMsg = document.getElementById("actMsg");
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-px],button[data-pr],button[data-mx],button[data-mr]");
    if (!b) return;
    var p;
    var extend = b.hasAttribute("data-px") || b.hasAttribute("data-mx");
    var days = extend ? prompt("Add how many days?", "7") : null;
    if (extend && !days) return;
    var reason = prompt(extend ? "Reason for the extension (admin log)?" : "Reason for revoking it (admin log)?");
    if (!reason) return;
    if (b.hasAttribute("data-px")) p = post("/api/admin/comps/plex/extend", { id: Number(b.getAttribute("data-px")), days: Number(days), reason: reason });
    else if (b.hasAttribute("data-pr")) p = post("/api/admin/comps/plex/revoke", { id: Number(b.getAttribute("data-pr")), reason: reason });
    else p = post("/api/admin/comps/premium/" + (extend ? "extend" : "revoke"), { tier: b.getAttribute("data-tier"), target: b.getAttribute("data-target"), days: Number(days), reason: reason });
    b.disabled = true;
    p.then(function (j) { after(j, actMsg, "Done."); }).catch(function () { say(actMsg, "Couldn't reach the server.", false); }).then(function () { b.disabled = false; });
  });

  // ── username suggestions (the same people search as @mentions) ──
  var dl = document.getElementById("compPeople"), last = "", tmr = null;
  document.addEventListener("input", function (ev) {
    var x = ev.target;
    if (!x || x.getAttribute("list") !== "compPeople") return;
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

  render();
})();
