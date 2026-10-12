// /settings/likeness (1.99qw): the opt-out switches. Each change is saved at once (POST /api/likeness/prefs).
(function () {
  "use strict";
  var root = document.getElementById("lk");
  if (!root) return;
  var msg = document.getElementById("lkMsg");
  var T = typeof __t === "function" ? __t : function (k, d) { return d; };
  function say(text, cls) {
    if (!msg) return;
    msg.textContent = text;
    msg.className = "lk-msg" + (cls ? " " + cls : "");
  }
  root.addEventListener("change", function (ev) {
    var el = ev.target;
    if (!el || !el.getAttribute || !el.getAttribute("data-lk-kind")) return;
    var kind = el.getAttribute("data-lk-kind");
    var body = {};
    body[kind] = !!el.checked;
    el.disabled = true;
    say(T("js.lk.saving", "Saving..."));
    fetch("/api/likeness/prefs", { method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", "x-requested-with": "fetch" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) {
        el.disabled = false;
        if (!d || !d.ok) {
          el.checked = !el.checked;
          say((d && d.error) || T("js.lk.failed", "Couldn't save that - try again."), "bad");
          return;
        }
        say(el.checked ? T("js.lk.on", "Allowed - you earn a cut when people use it.") : T("js.lk.off", "Opted out - nobody can use that on you now."), "ok");
      })
      .catch(function () { el.disabled = false; el.checked = !el.checked; say(T("js.lk.failed", "Couldn't save that - try again."), "bad"); });
  });
})();
