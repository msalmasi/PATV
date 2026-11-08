// public/js/media-admin.js — 1.99ji: /admin/media (mediaweb.js). Settings, connection checks, request links, the invite queue.
(function () {
  "use strict";
  function api(method, url, body) {
    var o = { method: method, credentials: "same-origin", headers: { Accept: "application/json", "X-Requested-With": "fetch" } };   // 1.99alq train3 verify (lists search)
    if (body) { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(body); }
    return fetch(url, o).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }).then(function (j) {
        // plexlists 1.99??: the server's reason code rides along (the outside-lists card says why)
        if (!r.ok || j.ok === false) { var err = new Error(j.error || ("HTTP " + r.status)); err.code = j.code; throw err; }
        return j;
      });
    });
  }
  function msg(id, t, good) { var e = document.getElementById(id); if (e) { e.textContent = t || ""; e.style.color = good ? "#9ccc65" : ""; } }

  // 1.99alq: the clerk's rebuildable catalog. Metadata is text, never HTML.
  var ct = function (key, fallback, values) {
    return window.__t ? window.__t("js.media.catalog." + key, fallback, values) : String(fallback).replace(/\{(\w+)\}/g, function (m, n) {
      return values && values[n] != null ? String(values[n]) : m;
    });
  };
  var pcTimer = null;
  function pcDate(value) {
    if (!value || !Number.isFinite(Number(value))) return ct("never", "Never");
    var date = new Date(Number(value));
    return isNaN(date.getTime()) ? ct("never", "Never") : date.toLocaleString();
  }
  function pcText(parent, tag, text) {
    var node = document.createElement(tag); node.textContent = text; parent.appendChild(node); return node;
  }
  function pcDraw(j, dry) {
    var out = document.getElementById("pcOut");
    if (!out) return;
    while (out.firstChild) out.removeChild(out.firstChild);
    if (dry) pcText(out, "p", ct("dry_result", "Read-only count: {n} items in allowed sections. The catalog was not changed.", { n: j.allowed_count || 0 }));
    else {
      pcText(out, "p", j.requires_1_7 ? ct("needs_version", "Needs media-control 1.7.0.") :
        !j.allow_list_set ? ct("needs_policy", "Set MEDIACTL_SECTIONS on the media-control host after reviewing the sections.") :
        j.ready ? ct("ready", "Catalog ready: {n} titles.", { n: j.count || 0 }) : ct("not_ready", "Catalog unavailable or more than three days out of date. Ordinary title search stays available."));
      pcText(out, "p", ct("details", "Media-control {version} · Last sync: {at} · Last full sync: {full}", {
        version: j.version || "—", at: pcDate(j.at), full: pcDate(j.full_at)
      }));
      if (j.embed) pcText(out, "p", !j.embed.enabled ? ct("embed_off", "Summary embeddings are off.") :
        !j.embed.model ? ct("embed_waiting", "Summary embeddings: waiting for the bot’s model configuration.") :
        ct("embed_progress", "Summary embeddings: {done} ready · {left} left · {model} ({dim} dimensions).", {
          done: Number(j.embed.done) || 0, left: Number(j.embed.left) || 0, model: j.embed.model, dim: Number(j.embed.dim) || 0
        }));
      if (j.syncing) pcText(out, "p", ct("syncing", "Catalog sync is running. You can leave this page."));
      // 1.99alx catfix: an unfinished full sync (it carries on from where it stopped) and when the last error happened
      if (j.progress) pcText(out, "p", ct("progress", "Full sync in progress since {at}: {done} of {total} sections read, {n} titles so far. The next run carries on from there.", {
        at: pcDate(j.progress.started), done: Number(j.progress.done) || 0, total: Number(j.progress.total) || 0, n: Number(j.progress.received) || 0
      }));
      if (j.error) pcText(out, "p", j.error_at ? ct("last_error_at", "Last sync error ({at}): {error}", { at: pcDate(j.error_at), error: j.error })
        : ct("last_error", "Last sync error: {error}", { error: j.error }));
      if (j.shelves_skipped && j.shelves_skipped.length) pcText(out, "p", ct("shelves_skipped", "Collections not refreshed by the last full sync, kept as they were: section {list}.", {
        list: j.shelves_skipped.map(function (x) { return String(x.section) + " (" + String(x.why || "") + ")"; }).join(", ")
      }));
    }
    var wrap = pcText(out, "div", ""); wrap.className = "tblwrap";
    var table = pcText(wrap, "table", ""), head = pcText(pcText(table, "thead", ""), "tr", "");
    [ct("id", "Section ID"), ct("name", "Section"), ct("type", "Type"), ct("policy", "Policy"), ct("count", "Items")].forEach(function (label) { pcText(head, "th", label); });
    var body = pcText(table, "tbody", "");
    (j.sections || []).forEach(function (section) {
      var tr = pcText(body, "tr", "");
      var policy = section.policy === "allowed" ? ct("allowed", "Allowed") : section.policy === "adult" ? ct("adult", "Adult: excluded") : ct("off", "Excluded");
      [section.id, section.policy === "allowed" ? section.title : ct("hidden", "(hidden)"),
        section.type === "show" ? ct("shows", "Shows") : ct("movies", "Movies"), policy, Number(section.count) || 0].forEach(function (value) { pcText(tr, "td", value); });
    });
    if (!(j.sections || []).length) { var cell = pcText(pcText(body, "tr", ""), "td", ct("no_sections", "No sections read yet.")); cell.colSpan = 5; }
  }
  function pcLoad() {
    if (!document.getElementById("pcOut")) return Promise.resolve();
    clearTimeout(pcTimer);
    return api("GET", "/api/media/admin/catalog").then(function (j) {
      pcDraw(j, false);
      if (j.syncing) pcTimer = setTimeout(function poll() {
        if (document.hidden) pcTimer = setTimeout(poll, 4000); else pcLoad();
      }, 4000);
    }).catch(function () { msg("pcMsg", ct("failed", "Could not read the catalog status. Try Refresh.")); });
  }
  function pcAction(id, route, body) {
    var button = document.getElementById(id);
    if (!button) return;
    button.addEventListener("click", function () {
      button.disabled = true; msg("pcMsg", ct("loading", "Loading…"));
      api("POST", route, body).then(function (j) {
        if (id === "pcDry") { pcDraw(j, true); msg("pcMsg", ct("dry_done", "Read-only count complete."), true); }
        else { msg("pcMsg", ct("sync_started", "Sync started. Status updates automatically."), true); pcLoad(); }
      }).catch(function () { msg("pcMsg", ct("action_failed", "The catalog action could not finish. Refresh to check its status.")); })
        .then(function () { button.disabled = false; });
    });
  }
  pcAction("pcSync", "/api/media/admin/catalog/sync", { full: true });
  pcAction("pcDry", "/api/media/admin/catalog/dry", {});
  var pcRefresh = document.getElementById("pcRefresh");
  if (pcRefresh) pcRefresh.addEventListener("click", pcLoad);
  window.addEventListener("pagehide", function () { clearTimeout(pcTimer); });
  pcLoad();

  // Admin-configured lists. Provider metadata is rendered as text, never markup.
  var lt = function (key, fallback, values) {
    return window.__t ? window.__t("js.media.lists." + key, fallback, values) : String(fallback).replace(/\{(\w+)\}/g, function (m, n) {
      return values && values[n] != null ? String(values[n]) : m;
    });
  };
  function clClear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function clText(parent, tag, value) { var node = document.createElement(tag); node.textContent = value; parent.appendChild(node); return node; }
  function clStatus(value) { var node = document.getElementById("clStatus"); if (node) node.textContent = value; }
  // plexlists 1.99??: why an add / refresh / search was refused (the server's code), or the caller's generic line
  function clWhy(e, otherwise) {
    switch (e && e.code) {
      case "lists_busy": return lt("busy", "The catalog is busy right now. Try again in a minute.");
      case "invalid_list": return lt("why_invalid_list", "Use an MDBList list number, or a list link like https://mdblist.com/lists/user-name/list-name.");
      case "not_found": return lt("why_not_found", "MDBList has no list there. Check the number or the link.");
      case "ambiguous_list": return lt("why_ambiguous_list", "That link matches more than one list. Add the list by its number instead.");
      case "list_limit": return lt("why_list_limit", "The outside-list limit is reached. Remove a list before adding another.");
      case "quiet": return lt("why_quiet", "Outside lists aren’t read during the nightly maintenance window (03:40-04:20 UTC). Try again after it.");
      case "rate_limited": case "daily_budget": return lt("why_rate_limited", "MDBList’s allowance for today is used up, or it asked us to wait. Try again later.");
      case "provider_auth": return lt("why_provider_auth", "MDBList refused the API key. Check MDBLIST_API_KEY on the server.");
      case "provider_unavailable": case "provider_timeout": case "provider_invalid": return lt("why_provider", "MDBList didn’t answer properly. Try again later.");
      case "list_too_large": return lt("why_list_too_large", "That list is too large to read (more than 20,000 titles).");
      default: return otherwise();
    }
  }
  function clAction(button, route, body) {
    button.disabled = true; msg("clMsg", lt("working", "Working…"));
    return api("POST", "/api/media/admin/lists/" + route, body).then(function () {
      msg("clMsg", lt("updated", "List settings updated."), true); return clLoad();
    }).catch(function (e) { msg("clMsg", clWhy(e, function () { return lt("failed", "The list action could not finish. Refresh the page to check its status."); })); })
      .then(function () { button.disabled = false; });
  }
  function clButton(parent, label, route, body) {
    var button = clText(parent, "button", label); button.type = "button"; button.className = "btn";
    button.addEventListener("click", function () { clAction(button, route, body); });
  }
  function clDraw(result) {
    var out = document.getElementById("clOut"), controls = document.getElementById("clControls"), searchOut = document.getElementById("clSearchOut");
    clClear(out); controls.hidden = !result.configured;
    if (!result.configured) { clClear(searchOut); clStatus(lt("needs_key", "Needs MDBLIST_API_KEY on the server.")); return; }
    clStatus(result.enabled ? lt("enabled", "Configured lists are available to the clerk.") : lt("off", "Lists are saved here. Enable outside lists in Settings to make them available to the clerk."));
    var wrap = clText(out, "div", ""); wrap.className = "tblwrap";
    var table = clText(wrap, "table", ""), head = clText(clText(table, "thead", ""), "tr", "");
    [lt("name", "List"), lt("kind", "Order"), lt("items", "Items"), lt("matched", "Matched"), lt("unmatched", "Unmatched"), lt("read", "Last read"), lt("error", "Last error"), lt("actions", "Actions")].forEach(function (label) { clText(head, "th", label); });
    var body = clText(table, "tbody", "");
    (result.lists || []).forEach(function (list) {
      var row = clText(body, "tr", "");
      [list.name, list.ranked ? lt("ranked", "Ranked") : lt("unranked", "Unranked"), Number(list.items) || 0,
        Number(list.matched) || 0, Number(list.unmatched) || 0, pcDate(list.last_read),
        list.last_error ? lt("retry", "Could not refresh; try again later.") : "—"].forEach(function (value) { clText(row, "td", value); });
      var actions = clText(row, "td", "");
      clButton(actions, lt("refresh", "Refresh"), "refresh", { id: list.id });
      clButton(actions, lt("remove", "Remove"), "remove", { id: list.id });
    });
    if (!(result.lists || []).length) { var empty = clText(clText(body, "tr", ""), "td", lt("empty", "No outside lists configured.")); empty.colSpan = 8; }
  }
  function clLoad() {
    if (!document.getElementById("clerkLists")) return Promise.resolve();
    return api("GET", "/api/media/admin/lists").then(clDraw).catch(function (e) {
      clStatus(e && e.code === "lists_busy" ? lt("busy", "The catalog is busy right now. Try again in a minute.") : lt("load_failed", "Could not read the outside lists. Refresh the page to try again."));
    });
  }
  var clAdd = document.getElementById("clAdd");
  if (clAdd) clAdd.addEventListener("click", function () {
    var input = document.getElementById("clInput").value.trim();
    if (!input) { msg("clMsg", lt("input_needed", "Enter an MDBList ID or URL.")); return; }
    clAction(clAdd, "add", { input: input });
  });
  var clSearch = document.getElementById("clSearch");
  if (clSearch) clSearch.addEventListener("click", function () {
    var query = document.getElementById("clQuery").value.trim(), out = document.getElementById("clSearchOut");
    if (query.length < 2) { msg("clMsg", lt("query_needed", "Enter at least two characters to find a list.")); return; }
    clSearch.disabled = true; clClear(out);
    api("GET", "/api/media/admin/lists/search?q=" + encodeURIComponent(query)).then(function (result) {
      (result.lists || []).forEach(function (list) {
        var row = clText(out, "p", list.name + " · " + (Number(list.items) || 0));
        clButton(row, lt("add", "Add list"), "add", { input: String(list.id) });
      });
      if (!(result.lists || []).length) clText(out, "p", lt("no_results", "No matching lists."));
    }).catch(function (e) { msg("clMsg", clWhy(e, function () { return lt("search_failed", "Could not search lists. Try again later."); })); })
      .then(function () { clSearch.disabled = false; });
  });
  clLoad();

  // connection checks
  api("GET", "/api/media/admin/checks").then(function (j) {
    ["mediactl", "overseerr", "wizarr", "tautulli"].forEach(function (k) {
      var td = document.querySelector('[data-ck="' + k + '"]');
      if (!td) return;
      var c = j.checks[k];
      td.textContent = c == null ? "— (no keys)" : c.ok ? "✅" + (c.version ? " v" + c.version : "") + (c.streams != null ? " · " + c.streams + " streams" : "") : "⚠ " + (c.error || "no");
    });
  }).catch(function (e) { document.querySelectorAll("[data-ck]").forEach(function (td) { td.textContent = "⚠ " + e.message; }); });

  // 1.99nj: 📊 Plex watch stats (plexstats.js)
  function psLoad() {
    var out = document.getElementById("psOut");
    if (!out) return;
    api("GET", "/api/media/admin/plexstats").then(function (j) {
      var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
      var when = function (t) { return t ? new Date(Number(t)).toISOString().slice(0, 16).replace("T", " ") : "—"; };
      var html = "<p class=\"muted\">" + (j.configured ? "Every " + j.every_min + " min." : "Not configured (TAUTULLI_URL, TAUTULLI_API_KEY).") +
        (j.last ? " Last run " + when(j.last.at) + ": " + j.last.synced + " ok, " + j.last.failed + " failed, " + j.last.not_in_tautulli + " not in Tautulli." : "") + "</p>";
      if (j.accounts.length) {
        html += "<div class=\"tblwrap\"><table><thead><tr><th>Account</th><th>Synced</th><th>In Tautulli</th><th>Last error</th></tr></thead><tbody>" +
          j.accounts.map(function (a) { return "<tr><td>" + esc(a.username || a.user_id) + "</td><td>" + when(a.synced_at) + "</td><td>" + (a.found ? "✅" : a.synced_at ? "—" : "") +
            "</td><td>" + (a.error ? esc(a.error) + " (" + when(a.error_at) + ")" : "") + "</td></tr>"; }).join("") + "</tbody></table></div>";
      }
      out.innerHTML = html;
    }).catch(function (e) { out.textContent = "⚠ " + e.message; });
  }
  psLoad();
  var psSync = document.getElementById("psSync");
  if (psSync) psSync.addEventListener("click", function () {
    psSync.disabled = true; msg("psMsg", "Syncing…");
    api("POST", "/api/media/admin/plexstats/sync", {}).then(function (j) {
      msg("psMsg", j.configured === false ? "Not configured." : j.synced + " ok, " + j.failed + " failed.", true); psLoad();
    }).catch(function (e) { msg("psMsg", e.message); }).then(function () { psSync.disabled = false; });
  });

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
  // ── 1.99jp: 📼 Plex members (plexmembers.js) ──
  var pm = document.getElementById("pmOut");
  var esc = function (t) { return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var day = function (ms) { return ms ? new Date(Number(ms)).toISOString().slice(0, 10) : ""; };
  function accessTxt(r) {
    var a = r.access || "?";
    if (r.access_pinned) a += " 📌";
    if (r.expires) a += (Number(r.expires) > Date.now() ? " · until " : " · ended ") + day(r.expires);
    return a;
  }
  function table(head, rows) {
    return '<div class="tblwrap"><table><thead><tr>' + head.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead><tbody>" +
      (rows.length ? rows.join("") : '<tr><td colspan="' + head.length + '" class="muted">None.</td></tr>') + "</tbody></table></div>";
  }
  function summary(r) {
    if (!r) return '<p class="muted">Not synced since the site started - press Sync now.</p>';
    if (r.error) return '<p class="muted">Last sync failed: ' + esc(r.error) + "</p>";
    var src = Object.keys(r.by_source || {}).map(function (k) { return k + " " + r.by_source[k]; }).join(", ");
    var acc = Object.keys(r.by_access || {}).map(function (k) { return k + " " + r.by_access[k]; }).join(", ");
    return "<p><b>" + (r.dry ? "Preview (nothing saved)" : "Last sync") + " " + esc(new Date(r.at).toISOString().slice(0, 16).replace("T", " ")) + ":</b> " +
      r.plex_users + " Plex users (" + r.pending + " invites not accepted yet) · " + r.linked + " linked (" + esc(src || "-") + "; " + r.auto_linked + " newly) · " +
      r.unlinked + " unlinked · access: " + esc(acc || "-") + " · would remove: " + r.candidates + (r.revoked ? " · removed: " + r.revoked : "") +
      (r.errors && r.errors.length ? '<br><span class="muted">' + esc(r.errors.join(" · ")) + "</span>" : "") + "</p>";
  }
  function draw(j, preview) {
    var h = summary(preview || j.last);
    h += '<p class="muted">Removing ended access: <b>' + (j.on.auto_revoke ? "AUTOMATIC" : "you confirm each one") + "</b>" + (j.on.sync ? "" : " · media-control isn't configured, so nothing syncs") + "</p>";
    h += "<h3>Would remove (PATV-sold access ended)</h3>" + table(["Plex user", "PATV", "Access", "", ""], j.candidates.map(function (r) {
      return '<tr data-pm="' + esc(r.plex_id) + '"><td>' + esc(r.username || r.plex_id) + "</td><td>" + esc(r.patv || "") + "</td><td>" + esc(accessTxt(r)) +
        (r.revoke === "failed" ? ' <span class="muted">(last try failed: ' + esc(r.revoke_error || "") + ")</span>" : "") + "</td>" +
        '<td><button type="button" class="btn danger" data-pm-act="revoke">Remove access</button></td><td><button type="button" class="btn" data-pm-act="keep">Keep (manual)</button></td></tr>';
    }));
    h += "<h3>Linked (" + j.linked.length + ")</h3>" + table(["Plex user", "PATV", "How", "Access", ""], j.linked.map(function (r) {
      return '<tr data-pm="' + esc(r.plex_id) + '"><td>' + esc(r.username || r.plex_id) + (r.pending ? ' <span class="muted">(invite pending)</span>' : "") + "</td><td>" + esc(r.patv || r.user_id) +
        "</td><td>" + esc(r.link_source || "") + (r.link_lock ? " 🔒" : "") + "</td><td>" + esc(accessTxt(r)) + "</td><td>" +
        '<button type="button" class="btn" data-pm-act="unlink">Unlink</button> ' +
        (r.access === "owner" && r.access_pinned ? '<span class="muted">📼 server owner</span>' :
          r.access_pinned ? '<button type="button" class="btn" data-pm-act="auto">Unpin</button>' : '<button type="button" class="btn" data-pm-act="pre">Pin pre-existing</button>') +
        (r.patv ? ' <a class="btn" href="/admin/comps?user=' + encodeURIComponent(r.patv) + '#plex">🎁 Comp</a>' : "") + "</td></tr>";
    }));
    h += "<h3>Unlinked (" + j.unlinked.length + ")</h3>" + table(["Plex user", "Suggested", "Link to PATV user", ""], j.unlinked.map(function (r) {
      return '<tr data-pm="' + esc(r.plex_id) + '"><td>' + esc(r.username || r.plex_id) + (r.title && r.title !== r.username ? ' <span class="muted">' + esc(r.title) + "</span>" : "") +
        (r.pending ? ' <span class="muted">(invite pending)</span>' : "") + "</td><td>" + esc(r.suggest || "") + '</td><td><input type="text" data-pm-user maxlength="48" placeholder="PATV username" value="' + esc(r.suggest || "") + '"></td>' +
        '<td><button type="button" class="btn" data-pm-act="link">Link</button></td></tr>';
    }));
    h += "<h3>PATV buyers with no linked Plex account (" + j.buyers.length + ")</h3>" + table(["PATV", "Orders", "Last", "Their access"], j.buyers.map(function (b) {
      return "<tr><td>" + esc(b.username || b.user_id) + "</td><td>" + b.orders + "</td><td>" + day(b.last) + "</td><td>" + esc((b.access || "-") + (b.expires ? (b.active ? " until " : " ended ") + day(b.expires) : "")) + "</td></tr>";
    }));
    if (j.off_server.length) h += "<details><summary>No longer on the server (" + j.off_server.length + ")</summary>" + table(["Plex user", "PATV", "Why"], j.off_server.map(function (r) {
      return "<tr><td>" + esc(r.username || r.plex_id) + "</td><td>" + esc(r.patv || "") + "</td><td>" + esc(r.revoke === "revoked" ? "removed by " + (r.revoke_by || "?") + " " + day(r.revoke_at) : "share gone") + "</td></tr>";
    })) + "</details>";
    h += '<details><summary>Log</summary><ul class="muted">' + j.log.map(function (l) { return "<li>" + esc(new Date(l.ts).toISOString().slice(0, 16).replace("T", " ") + " " + l.what + " (" + (l.actor || "") + ") " + (l.detail || "")) + "</li>"; }).join("") + "</ul></details>";
    pm.innerHTML = h;
  }
  function loadPm(preview) {
    if (!pm) return;
    api("GET", "/api/media/admin/plex").then(function (j) { draw(j, preview); }).catch(function (e) { pm.innerHTML = '<p class="muted">' + esc(e.message) + "</p>"; });
  }
  loadPm();
  ["pmSync", "pmDry"].forEach(function (id) {
    var b = document.getElementById(id);
    if (b) b.addEventListener("click", function () {
      var dry = id === "pmDry";
      b.disabled = true;
      msg("pmMsg", dry ? "Previewing…" : "Syncing…", true);
      api("POST", "/api/media/admin/plex/sync", { dry: dry }).then(function (j) { msg("pmMsg", dry ? "Preview below - nothing was saved." : "Synced.", true); loadPm(dry ? j.result : null); })
        .catch(function (e) { msg("pmMsg", e.message); }).then(function () { b.disabled = false; });
    });
  });
  if (pm) pm.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-pm-act]");
    if (!b) return;
    var tr = b.closest("[data-pm]"), id = tr.getAttribute("data-pm"), act = b.getAttribute("data-pm-act"), name = tr.cells[0].textContent;
    var call;
    if (act === "revoke") { if (!confirm("Remove " + name + "'s access to the Plex server? (Their PATV-sold access ended. This removes the library share on Plex.)")) return; call = api("POST", "/api/media/admin/plex/revoke", { plex_id: id }); }
    else if (act === "keep") call = api("POST", "/api/media/admin/plex/pin", { plex_id: id, access: "manual" });
    else if (act === "pre") call = api("POST", "/api/media/admin/plex/pin", { plex_id: id, access: "pre-existing" });
    else if (act === "auto") call = api("POST", "/api/media/admin/plex/pin", { plex_id: id, access: "auto" });
    else if (act === "unlink") { if (!confirm("Unlink " + name + "? A sync won't link it again by itself.")) return; call = api("POST", "/api/media/admin/plex/link", { plex_id: id, username: "" }); }
    else if (act === "link") {
      var u = tr.querySelector("[data-pm-user]").value.trim();
      if (!u) { msg("pmMsg", "Type the PATV username."); return; }
      call = api("POST", "/api/media/admin/plex/link", { plex_id: id, username: u });
    }
    b.disabled = true;
    call.then(function () { msg("pmMsg", "Done.", true); loadPm(); }).catch(function (e) { msg("pmMsg", e.message); b.disabled = false; });
  });
})();
