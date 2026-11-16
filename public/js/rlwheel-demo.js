/* The roulette wheel demo page (public/rlwheel-demo.html): drives the public wheel module with a pretend table.
   No server state, no account, no PAT - the pocket is chosen here. Not linked from anywhere. */
(function () {
  "use strict";
  var W = window.PATVRlWheel;
  var $ = function (id) {
    return document.getElementById(id);
  };
  if (!W || !W.mount) {
    $("err").hidden = false;
    return;
  }
  var TABLE = "demo-wheel",
    round = 1,
    current = null,
    timers = [],
    events = [];
  function log(type) {
    var t = current ? ((Date.now() - current.startedAt) / 1000).toFixed(2) + " s" : "";
    events.unshift(t + "  " + type);
    events.length = Math.min(events.length, 7);
    var ul = $("log");
    ul.replaceChildren();
    events.forEach(function (e) {
      var li = document.createElement("li");
      li.textContent = e;
      ul.append(li);
    });
  }
  var big = W.mount($("w-big"), { onEvent: log }),
    tilt = W.mount($("w-tilt"), { tilt: 40 }),
    mini = W.mount($("w-mini"), { compact: true }),
    wheels = [big, tilt, mini];
  var sel = $("pocket");
  W.WHEEL.slice()
    .sort(function (a, b) {
      return a - b;
    })
    .forEach(function (n) {
      var o = document.createElement("option");
      o.value = String(n);
      o.textContent = n + " " + (n === 0 ? "zero" : W.RED.indexOf(n) >= 0 ? "red" : "black");
      sel.append(o);
    });
  function each(fn) {
    wheels.forEach(fn);
  }
  function clear() {
    timers.forEach(clearTimeout);
    timers = [];
  }
  function later(ms, fn) {
    timers.push(setTimeout(fn, Math.max(0, ms)));
  }
  function show(id, text) {
    $(id).textContent = text;
  }
  function spin(opts) {
    opts = opts || {};
    clear();
    var D = Number($("secs").value) * 1000,
      pocket = sel.value === "r" ? Math.floor(Math.random() * 37) : Number(sel.value),
      startedAt = Date.now() - (opts.lateMs || 0),
      view = { tableId: TABLE, round: round++, pocket: pocket, startedAt: startedAt, landAt: startedAt + D };
    var a = performance.now(),
      p = W.plan(view),
      ms = performance.now() - a;
    current = view;
    events = [];
    log(opts.lateMs ? "joined " + (opts.lateMs / 1000).toFixed(1) + " s late" : "no more bets");
    each(function (w) {
      w.spin(view);
    });
    show("o-phase", "spinning");
    show("o-pocket", pocket + " " + (pocket === 0 ? "zero" : W.RED.indexOf(pocket) >= 0 ? "red" : "black"));
    show("o-settle", ((p.settleAt - startedAt) / 1000).toFixed(2) + " s (" + Math.round(view.landAt - p.settleAt) + " ms before land_at)");
    show("o-sk", "slot " + p.s + ", rotor shifted " + p.k + " pockets");
    show("o-dh", p.stats.diamonds + " / " + p.stats.hops);
    show("o-ms", ms.toFixed(2) + " ms");
    var resultAt = opts.earlyMs ? p.settleAt - opts.earlyMs : view.landAt;
    later(resultAt - Date.now(), function () {
      each(function (w) {
        w.rest(pocket);
      });
      show("o-phase", "result: " + pocket);
      log("result " + pocket);
    });
    if ($("auto").checked)
      later(view.landAt + 5000 - Date.now(), function () {
        idle();
        later(6000, function () {
          if ($("auto").checked) spin();
        });
      });
  }
  function idle() {
    clear();
    each(function (w) {
      w.idle();
    });
    show("o-phase", "bets open");
    log("bets open");
  }
  $("secs").addEventListener("input", function () {
    show("secs-v", this.value + " s");
  });
  $("b-spin").addEventListener("click", function () {
    spin();
  });
  $("b-late").addEventListener("click", function () {
    spin({ lateMs: Math.round(Number($("secs").value) * 500) });
  });
  $("b-early").addEventListener("click", function () {
    spin({ earlyMs: 1500 });
  });
  $("b-idle").addEventListener("click", idle);
  $("auto").addEventListener("change", function () {
    if (this.checked) spin();
  });
  $("reduced").addEventListener("change", function () {
    var on = this.checked;
    each(function (w) {
      w.setReduced(on ? true : null);
    });
  });
  $("pal").addEventListener("change", function () {
    var v = this.value;
    each(function (w) {
      w.setPalette(v);
    });
  });
})();
