/* Single-zero felt, wheel animation and verified table state. */
(function (W) {
  "use strict";
  var CZ = W.CZ,
    R = W.PATVRoulette,
    G = W.PATVRlBets;
  if (!CZ || !CZ.tableId || !R || !G) return;
  var $ = CZ.$,
    T = CZ.T,
    grid = $("rl-grid"),
    out = $("rl-outside"),
    nodes = Object.create(null);
  var wheel = [
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29,
    7, 28, 12, 35, 3, 26,
  ];
  var last = null,
    mode = "straight",
    first = null,
    refresh,
    controls,
    lastSpin = 0,
    angle = 0;
  // UI-3: the phone's way of betting inside positions (modes + two taps) on any touch screen too (views/partials/casino-rl-css.ejs)
  var compact = W.matchMedia("(max-width:639px), (pointer:coarse)"),
    narrow = W.matchMedia("(max-width:639px)"),
    reduced = W.matchMedia("(prefers-reduced-motion:reduce)");
  function color(n) {
    return !n ? "zero" : G.red.indexOf(n) >= 0 ? "red" : "black";
  }
  function word(n) {
    return R.outcome(n);
  }
  function svg(tag, attrs, txt) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs).forEach(function (k) {
      e.setAttribute(k, attrs[k]);
    });
    if (txt !== undefined) e.textContent = txt;
    return e;
  }
  function circle(parent, r, fill, stroke) {
    parent.append(svg("circle", { cx: 0, cy: 0, r: r, fill: fill, stroke: stroke || "none" }));
  }
  function drawWheel() {
    var s = $("rl-wheel"),
      rotor = svg("g", { id: "rl-rotor" });
    circle(s, 122, "#3e241c", "#c99761");
    circle(s, 117, "#92623d", "#efd59d");
    circle(s, 112, "#201d18", "#f2d3a2");
    s.append(rotor);
    var a = Math.PI / 37,
      x = (110 * Math.sin(a)).toFixed(2),
      y = (-110 * Math.cos(a)).toFixed(2);
    wheel.forEach(function (n, i) {
      var segment = svg("g", { transform: "rotate(" + (i * 360) / 37 + ")" });
      segment.append(
        svg("path", {
          d: "M0 0 L-" + x + " " + y + " A110 110 0 0 1 " + x + " " + y + " Z",
          fill: { zero: "#1e7f4f", red: "#d3343a", black: "#141418" }[color(n)],
          stroke: "#c8ac77",
          "stroke-width": ".65",
        }),
      );
      segment.append(
        svg(
          "text",
          {
            x: 0,
            y: -94,
            fill: "white",
            "text-anchor": "middle",
            "font-size": 9,
            "font-family": "Georgia",
            "font-weight": 700,
          },
          n,
        ),
      );
      rotor.append(segment);
    });
    circle(rotor, 80, "#815537", "#edc78e");
    circle(rotor, 71, "#30211d", "#bc8a53");
    circle(rotor, 65, "#603a25", "#452518");
    circle(rotor, 48, "#382219", "#bb8959");
    for (var i = 0; i < 4; i++) {
      var spoke = svg("g", { transform: "rotate(" + i * 90 + ")" });
      spoke.append(
        svg("rect", { x: -3, y: -34, width: 6, height: 34, rx: 3, fill: "#ddb575" }),
        svg("circle", { cx: 0, cy: -34, r: 5, fill: "#f1d5a4" }),
      );
      rotor.append(spoke);
    }
    circle(rotor, 13, "#ca9761", "#ebd6a5");
    circle(rotor, 7, "#f5d590", "#a57c4e");
  }
  var names = {
    straight: T("rl_straight", "Number"),
    split: T("rl_split", "Split"),
    street: T("rl_street", "Street"),
    corner: T("rl_corner", "Corner"),
    line: T("rl_six", "Line"),
  };
  var kinds = Object.assign(
    {
      trio: T("rl_trio", "Trio"),
      first_four: T("rl_first_four", "First four"),
      dozen: T("rl_dozen", "Dozen"),
      column: T("rl_column", "Column"),
    },
    names,
  );
  var felt = {};
  R.outside.forEach(function (p) {
    if (/^(?:[dc][123]|low|high)$/.test(p[0])) felt[p[0]] = p[1];      // (red / even ... read as they are)
  });
  function choose(n) {
    if (!compact.matches || mode === "straight") {
      controls.place(String(n));
      return;
    }
    if (first === null) {
      first = n;
      $("rl-instruction").textContent = T("rl_second", "Choose the other end of your {kind}.", { kind: names[mode] });
      return;
    }
    var a = first,
      b = n;
    first = null;
    var matches = Object.values(G.positions).filter(function (p) {
      var type =
        p.kind === mode || (mode === "street" && p.kind === "trio") || (mode === "corner" && p.kind === "first_four");
      return type && a !== b && p.nums.includes(a) && p.nums.includes(b);
    });
    // Two endpoints select one position. For ambiguous neighbours, ask for opposite ends.
    if (matches.length !== 1) {
      $("rl-instruction").textContent = T("rl_endpoints", "Choose two opposite ends of one position.");
      return;
    }
    $("rl-instruction").textContent = "";
    controls.place(matches[0].token);
  }
  Object.keys(names).forEach(function (k) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = names[k];
    b.setAttribute("aria-pressed", String(mode === k));
    b.onclick = function () {
      mode = k;
      first = null;
      $("rl-instruction").textContent = "";
      Array.from(b.parentNode.children).forEach(function (e) {
        e.setAttribute("aria-pressed", String(e === b));
      });
    };
    $("rl-modes").append(b);
  });
  function spot(token, label, cls, parent) {
    var b = document.createElement("button"),
      p = G.positions[token];
    b.type = "button";
    b.dataset.token = token;
    b.className = cls;
    b.title = token + " · " + p.odds + ":1";
    b.textContent = label;
    parent.append(b);
    nodes[token] = nodes[token] || [];
    nodes[token].push(b);
    var hold,
      handled = false;
    function cancel() {
      clearTimeout(hold);
    }
    b.onpointerdown = function (e) {
      handled = false;
      if (e.button === 0 && e.pointerType !== "mouse")
        hold = setTimeout(function () {
          handled = true;
          controls.undoPosition(token);
        }, 600);
    };
    b.onpointerup = cancel;
    b.onpointerleave = cancel;
    b.onpointercancel = cancel;
    b.oncontextmenu = function (e) {
      e.preventDefault();
      cancel();
      if (!handled) controls.undoPosition(token);
      handled = true;
    };
    b.onclick = function () {
      if (handled) {
        handled = false;
        return;
      }
      if (p.kind === "straight") choose(+token);
      else controls.place(token);
    };
    return b;
  }
  function cell(token, label, cls, c, r, mc, mr) {
    var b = spot(token, label, cls, grid);
    b.style.gridColumn = c;
    b.style.gridRow = r;
    b.style.setProperty("--mobile-col", mc);
    b.style.setProperty("--mobile-row", mr);
    return b;
  }
  function edge(token, x, y, shape) {
    var b = spot(token, "", "edge " + shape, grid);
    // Account for the narrower zero and wider column boxes.
    b.style.left = (100 * (x === 0 ? 0.9 : 0.9 + x)) / 14.15 + "%";
    b.style.top = (100 * y) / 3 + "%";
  }
  function paintBoard() {
    cell("0", "0", "zero", "1", "1 / span 3", "1 / span 3", "1");
    for (var n = 1; n <= 36; n++) {
      var col = Math.floor((n - 1) / 3),
        row = 2 - ((n - 1) % 3);
      var b = cell(
        String(n),
        n,
        color(n),
        String(col + 2),
        String(row + 1),
        String(((n - 1) % 3) + 1),
        String(col + 2),
      );
      var sym = document.createElement("span");
      sym.className = "symbol";
      sym.textContent = color(n) === "red" ? "◆" : "●";
      b.append(sym);
    }
    for (var k = 1; k <= 3; k++) cell("c" + k, "2:1", "", "14", String(4 - k), String(k), "14");
    Object.values(G.positions).forEach(function (p) {
      if (!["split", "street", "corner", "line", "trio", "first_four"].includes(p.kind)) return;
      var coords = p.nums.filter(Boolean).map(function (n) {
        return [Math.floor((n - 1) / 3) + 0.5, 2.5 - ((n - 1) % 3)];
      });
      var x =
          coords.reduce(function (a, v) {
            return a + v[0];
          }, 0) / coords.length,
        y =
          coords.reduce(function (a, v) {
            return a + v[1];
          }, 0) / coords.length;
      if (p.nums.includes(0)) {
        x = 0;
        if (p.kind === "first_four") y = 3;
      }
      if (p.kind === "street" || p.kind === "line") y = 3;
      var side = p.kind === "split" && p.nums[0] !== 0 && p.nums[1] - p.nums[0] === 1;
      edge(
        p.token,
        x,
        y,
        p.kind === "split" && !side ? "vertical" : side || p.kind === "street" ? "horizontal" : "cross",
      );
    });
    R.outside
      .slice(6, 9)
      .concat(R.outside.slice(0, 6))
      .forEach(function (p) {
        spot(p[0], p[1], p[0][0] === "d" ? "dozen" : p[0], out);
      });
    grid.onkeydown = function (e) {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) || e.altKey || e.metaKey || e.ctrlKey)
        return;
      var token = e.target.dataset.token;
      if (!/^\d+$/.test(token)) return;
      var delta = narrow.matches
        ? { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }
        : { ArrowLeft: -3, ArrowRight: 3, ArrowUp: 1, ArrowDown: -1 };
      var dest = Math.max(0, Math.min(36, +token + delta[e.key]));
      e.preventDefault();
      nodes[dest][0].focus();
    };
  }
  function chips(lines, pending) {
    var own = {},
      unpaid = {};
    lines.forEach(function (bs) {
      bs.forEach(function (b) {
        own[b.token] = (own[b.token] || 0) + b.amount;
      });
    });
    pending.forEach(function (b) {
      unpaid[b.b] = (unpaid[b.b] || 0) + Number(b.a);
    });
    Object.keys(nodes).forEach(function (token) {
      var st = own[token] || 0,
        p = G.positions[token],
        amount = st + (unpaid[token] || 0);
      // UI-8: what a screen reader says - the felt's own words, never the internal kind or token (first_four, d1, c2)
      var label = T("rl_position", "{spot}, {kind} pays {odds} to 1, your bet {n} PAT", {
        spot: p.kind === "straight" ? word(+token) : felt[token] || token,
        kind: kinds[p.kind] || T("rl_even_money", "Even money"),
        odds: p.odds,
        n: CZ.fmt(st),
      });
      nodes[token].forEach(function (b) {
        b.setAttribute("aria-label", label);
        if (amount) b.setAttribute("data-stake", CZ.short(amount));
        else b.removeAttribute("data-stake");
        b.classList.toggle("awaiting", !!unpaid[token]);
      });
    });
  }
  function spin(t) {
    if (!t.spin || lastSpin === t.spin.round_no) return;
    lastSpin = t.spin.round_no;
    var idx = wheel.indexOf(t.spin.number),
      target = (360 - (idx * 360) / 37) % 360,
      rotor = $("rl-rotor");
    angle += 360 * 4 + ((target - (angle % 360) + 360) % 360);
    var ms = Math.max(0, t.land_at - (Date.now() - CZ.skew()));
    rotor.style.transition = reduced.matches ? "none" : "transform " + ms + "ms cubic-bezier(.17,.07,.16,1)";
    if (!reduced.matches) rotor.style.transform = "rotate(" + angle + "deg)";
  }
  function render(d) {
    var previous = last;
    last = d;
    var t = d.table,
      me = d.me,
      phase = R.phase(t);
    // ENGINE-4: a rotated lobby wheel names the fresh one - the page follows it (a queued line went along)
    if (t.status === "closed" && t.next_table && /^[a-f0-9]{10}$/.test(t.next_table)) {
      W.location.replace("/casino/roulette/t/" + t.next_table);
      return;
    }
    spin(t);
    controls.update(d);
    $("cb").classList.toggle("rl-lobby", !!t.lobby);
    $("cb").classList.toggle("rl-spinning", t.phase === "spinning");
    $("rl-phase").textContent = phase;
    var result = t.phase === "result" && t.last_round;
    var msg = result ? word(result.number) : T("rl_spin_number", "Spin {n}", { n: t.round_no });
    $("cz-msg").textContent = msg;
    if (result && (reduced.matches || lastSpin !== result.round_no)) {
      var rotor = $("rl-rotor");
      rotor.style.transition = "none";
      angle = (-wheel.indexOf(result.number) * 360) / 37;
      rotor.style.transform = "rotate(" + angle + "deg)";
    }
    $("rl-totals").hidden = !!result;
    $("rl-totals").textContent = T(
      "rl_totals",
      { "one": "{players} player · {pat} PAT this spin", "other": "{players} players · {pat} PAT this spin" },
      { players: t.totals.players, pat: CZ.fmt(t.totals.staked), count: t.totals.players },
    );
    var net =
      result && me && typeof me.net === "number"
        ? T("rl_net", "Your net {n} PAT", { n: (me.net > 0 ? "+" : "") + CZ.fmt(me.net) })
        : "";
    $("rl-net").textContent = net;
    $("rl-net").classList.toggle("win", !!(net && me.net > 0));
    var strip = $("rl-history");
    if (strip.dataset.round !== String(t.last_revealed)) {
      strip.dataset.round = String(t.last_revealed);
      strip.replaceChildren();
      t.history
        .slice(-20)
        .reverse()
        .forEach(function (r) {
          var li = document.createElement("li");
          li.textContent = (r.color === "red" ? "◆ " : r.number ? "● " : "") + r.number;
          li.title = word(r.number);
          strip.append(li);
        });
    }
    $("rl-proof").textContent = T("rl_commit_line", "Spin {n} commitment: {c} · client seed {s}", {
      n: t.commit_round,
      c: t.commitment || "",
      s: t.client_seed || "",
    });
    CZ.announce(phase + " · " + msg + (net ? " · " + net : ""));
    if (me && me.notice && me.notice.id === "rl_intro")
      CZ.note(
        T(
          "rl_intro",
          "PAT are points with no cash value. Each spin is independent. The wheel has a single zero and straight up pays 35 to 1.",
        ),
      );
    if (me && me.private_note && (!previous || !previous.me || previous.me.private_note !== me.private_note))
      CZ.toast(me.private_note, true);
  }
  var explanation = document.querySelector("#cz-histsheet .fine");
  if (explanation)
    explanation.textContent = T(
      "rl_fair_how",
      "Each spin is committed before bets open. After the result, open its proof to check the pocket in your browser.",
    );
  drawWheel();
  paintBoard();
  // UI-6: a signed-out viewer watches - say so, with the way in (the blackjack table's words)
  if (!CZ.signed) {
    var signin = document.createElement("p"),
      login = document.createElement("a");
    signin.className = "rl-signin";
    login.href = "/login";
    login.textContent = T("signin_play", "Sign in to play");
    signin.append("👁 " + T("watching_signin", "You're watching.") + " ", login);
    $("cz-dock").append(signin);
  }
  controls = R.controls($("cz-dock"), {
    id: CZ.tableId,
    refresh: function () {
      return refresh && refresh();
    },
    paint: chips,
  });
  $("cz-histbtn").onclick = function () {
    CZ.openSheet("cz-histsheet");
    CZ.loadHistory(function (r) {
      var pocket = r.results && r.results.number;
      return (
        '<div class="hh"><b>' +
        CZ.esc(Number.isInteger(pocket) ? word(pocket) : T("rl_spin_number", "Spin {n}", { n: r.round })) +
        '</b><a href="' +
        CZ.esc(r.proof) +
        '">🔐 ' +
        CZ.esc(T("verify", "verify")) +
        "</a></div>"
      );
    });
  };
  var act = CZ.actor({
    fn: function () {
      return refresh && refresh();
    },
  });
  CZ.wireHost(
    function () {
      return refresh();
    },
    function () {
      return act("end");
    },
  );
  refresh = CZ.startTable(render, { first: CZ.signed ? "?notice=1" : "" });
  fetch("/api/casino/lobby", { credentials: "same-origin" })
    .then(function (res) {
      return res.json();
    })
    .then(function (j) {
      ((j.roulette && j.roulette.wheels) || []).forEach(function (w) {
        if (w.id === CZ.tableId || !/^[a-f0-9]{10}$/.test(w.id)) return;
        var a = document.createElement("a");
        a.href = "/casino/roulette/t/" + w.id;
        a.textContent = w.room_name || T("rl_lobby", "Lobby wheel");
        $("rl-wheels").append(a);
      });
    })
    .catch(function () {});
})(window);
