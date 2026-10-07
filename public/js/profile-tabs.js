// profile-tabs.js — the profile page's tabs, "More" menu and GTF avatar popover (1.99du).
// Tabs are server-rendered panels (every tab's content is in the page, the open one picked by ?tab=);
// this switches them without a reload and keeps the URL deep-linkable. A #hash that names a tab
// (#posts, #overview, #analytics) or something inside one (#profile-settings, #badges) opens that tab.
// The GTF popover is a native [popover] (light dismiss + Esc); ?gtf=1 opens it on load - the "New
// avatar" form comes back there so the request's result shows.
(function () {
  "use strict";
  var root = document.querySelector(".pf[data-profile]");
  if (!root) return;
  var tabs = Array.prototype.slice.call(root.querySelectorAll(".pf-tab[data-tab]"));

  function panel(id) { return document.getElementById("tab-" + id); }

  function activate(id, opts) {
    var hit = false;
    tabs.forEach(function (t) {
      var on = t.getAttribute("data-tab") === id;
      if (on) hit = true;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.setAttribute("tabindex", on ? "0" : "-1");
      var p = panel(t.getAttribute("data-tab"));
      if (p) p.hidden = !on;
    });
    if (!hit) return false;
    if (opts && opts.url) {
      try { history.replaceState(history.state, "", opts.url); } catch (e) { /* file:// etc. */ }
    }
    return true;
  }

  tabs.forEach(function (t, i) {
    t.addEventListener("click", function (e) {
      if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // new tab / window: let it go
      e.preventDefault();
      activate(t.getAttribute("data-tab"), { url: t.getAttribute("href") });
    });
    t.addEventListener("keydown", function (e) {
      var j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
      if (j === null) return;
      e.preventDefault();
      var n = tabs[(j + tabs.length) % tabs.length];
      n.focus();
      activate(n.getAttribute("data-tab"), { url: n.getAttribute("href") });
    });
  });

  // #hash -> the tab it names or the tab that holds it
  function fromHash() {
    var h = (location.hash || "").slice(1);
    if (!h) return;
    if (activate(h)) return;
    var el = null;
    try { el = document.getElementById(decodeURIComponent(h)); } catch (e) { el = null; }
    var p = el && el.closest ? el.closest(".pf-panel[data-panel]") : null;
    if (p && p.hidden) {
      activate(p.getAttribute("data-panel"));
      setTimeout(function () { el.scrollIntoView(); }, 0);
    }
  }
  fromHash();
  window.addEventListener("hashchange", fromHash);

  // "⋯ More": close on an outside click or Esc
  var more = root.querySelector("[data-pf-more]");
  if (more) {
    document.addEventListener("click", function (e) { if (more.open && !more.contains(e.target)) more.open = false; });
    more.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && more.open) { more.open = false; var s = more.querySelector("summary"); if (s) s.focus(); }
    });
    // a menu item that opens the popover closes the menu
    Array.prototype.forEach.call(more.querySelectorAll("[data-gtf-open]"), function (b) {
      b.addEventListener("click", function () { more.open = false; });
    });
  }

  // GTF popover: native [popover]; older browsers get a plain toggle
  var pop = document.getElementById("gtfPop");
  if (pop) {
    var native = typeof pop.showPopover === "function";
    if (!native) {
      pop.style.display = "none";
      pop.style.position = "fixed";
      pop.style.inset = "0";
      pop.style.zIndex = "1000";
      Array.prototype.forEach.call(document.querySelectorAll("[popovertarget='gtfPop']"), function (b) {
        b.addEventListener("click", function () {
          var hide = b.getAttribute("popovertargetaction") === "hide" || pop.style.display !== "none";
          pop.style.display = hide ? "none" : "block";
        });
      });
    }
    var q = new URLSearchParams(location.search);
    if (q.get("gtf") === "1") {
      if (native) { try { pop.showPopover(); } catch (e) { /* already open */ } } else pop.style.display = "block";
    }
  }
})();
