/* Single-zero roulette table page (/casino/roulette/t/<id>) - 1.99aoj (O7 / O9 / O10 / O11 / O13, contracts 2, 7, 8, 9).
   Built on the casino's shared parts (casino-ui.js CZ: the top bar, the felt, Pepe's menu, the countdown ring, seats with the person
   menu, chips, pops, sheets, Host Tools) like the Blackjack and Hold'em tables:
   * the REAL wheel and ball (casino/rlwheel.js PATVRlWheel.mount): driven by spin.started_at / ends_at and the site clock, so it
     lands exactly on spin.number; the rotor turns between spins; a CSS tilt on a desktop, top-down on a phone; the wheel's own
     reduced-motion path; a small floating wheel on a phone while a spin runs and the big one is scrolled away;
   * the betting layout: 0-36 in the felt's colours, the outside bets, EVERYONE's chips per spot (D5: t.felt + seats[i].chips, the
     charged lines only; masked seats under their label), my chips highlighted, a total and a player count per spot; hovering or
     focusing a spot shows the numbers it covers, what it pays, its cap and my bet;
   * the players rail (avatar, name, stake, net at the result), the limits placard, Pepe as the croupier ("Place your bets", "Last
     bets…", "No more bets", "14 red"), the result moment (the winning number and every covering spot glow, losing chips raked,
     winners popped, a small gold burst on a straight-up hit - none of the motion under reduced motion), the history strip;
   * D8 extras: call bets (Voisins / Tiers / Orphelins / Neighbours ±2 - web shortcuts that place ONE ordinary line), ×2 and Rebet,
     keyboard shortcuts, a stats drawer that always says each spin is independent, a session line (sessionStorage), sound cues
     (casino-sound.js: off by default, unlocked by a gesture).
   Nothing here decides, changes or delays a result: the server draws and settles; the page shows its view. Every move posts with
   an idempotency key (casinorl-dock.js controls, shared with the pad's Room Dock). */
(function (W) {
  "use strict";
  var CZ = W.CZ,
    R = W.PATVRoulette,
    G = W.PATVRlBets;
  if (!CZ || !CZ.tableId || !R || !G) return;
  var $ = CZ.$,
    T = CZ.T,
    doc = W.document,
    grid = $("rl-grid"),
    out = $("rl-outside"),
    nodes = Object.create(null),
    stks = Object.create(null);
  var last = null,
    mode = "straight",
    first = null,
    refresh,
    controls,
    wheel = null,
    floater = null,
    unpaid = [],
    seenSpin = null,
    seenResult = null,
    rendered = false,
    prevPhase = null,
    previewed = null,
    showOthers = true;
  // UI-3: the phone's way of betting inside positions (modes + two taps) on any touch screen too (views/partials/casino-rl-css.ejs)
  var compact = W.matchMedia("(max-width:639px), (pointer:coarse)"),
    narrow = W.matchMedia("(max-width:639px)"),
    wide = W.matchMedia("(min-width:900px) and (pointer:fine)"),
    reducedMq = W.matchMedia("(prefers-reduced-motion:reduce)");
  var quick = false; //                      (O11: this viewer's ⚡ Quick spin - set from localStorage below)
  function reduced() {
    return !!reducedMq.matches || quick;
  }
  var store = {
    get: function (s, k) {
      try {
        return W[s] ? W[s].getItem(k) : null;
      } catch (_) {
        return null;
      }
    },
    set: function (s, k, v) {
      try {
        if (W[s]) W[s].setItem(k, v);
      } catch (_) {
        /* blocked storage: this page only */
      }
    },
  };
  showOthers = store.get("localStorage", "rl-others") !== "0";
  quick = store.get("localStorage", "rl-quick") === "1";
  // (review, WCAG 2.1.4: this viewer can turn the single-key shortcuts off - the ⌨ toggle; on unless they did)
  var keysOn = store.get("localStorage", "rl-keys") !== "0";
  // (review: how the focus came - a pointer (a mouse click focuses a button on Chrome / Windows, a tap does on Android) or the keyboard.
  // Not :focus-visible: Chrome starts matching it on the clicked button as soon as a key goes down, so a key handler can't tell.)
  var lastPointer = -1e9,
    pointerFocus = null; //                  (the control a pointer focused, while it keeps the focus)
  function pointerNow() {
    return Date.now() - lastPointer < 800;
  }
  function pointed(e) {
    lastPointer = Date.now();
    var tg = e && e.target;
    if (e && e.type === "pointerdown") pointerFocus = tg && tg.closest ? tg.closest("button,summary,a") : null;
  }
  doc.addEventListener("pointerdown", pointed, true);
  doc.addEventListener("pointerup", pointed, true);
  doc.addEventListener(
    "keydown",
    function () {
      lastPointer = -1e9; //                 (the keyboard is in use: a focus move now is the keyboard's - Tab, the arrows)
    },
    true,
  );
  doc.addEventListener(
    "focusin",
    function (e) {
      pointerFocus = pointerNow() ? e.target : null;
    },
    true,
  );
  function color(n) {
    return R.pocketColor(n);
  }
  function word(n) {
    return R.outcome(n);
  }
  function on(el, type, fn) {
    if (el && el.addEventListener) el.addEventListener(type, fn);
  }
  function fire(name, detail) {
    try {
      doc.dispatchEvent(new W.CustomEvent(name, { detail: detail }));
    } catch (_) {
      /* an old browser: no client events */
    }
  }
  function sound(name) {
    if (W.CZSound && W.CZSound.cue) W.CZSound.cue(name);
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
  /** a spot in the felt's words: "17 ● Black", "17–20", "1–12", "◆ Red" (the hover line and the spoken name add its kind) */
  function spotWords(token) {
    var p = G.positions[token];
    if (!p) return token;
    if (p.kind === "straight") return word(+token);
    if (felt[token]) return felt[token];
    if (/^(?:red|black|even|odd)$/.test(token)) return R.spotName(token);
    return p.nums.join("–");
  }

  // ── the wheel (casino/rlwheel.js; a page without it keeps the felt and the history - the server's result is always shown) ──
  var canvas = $("rl-wheel"),
    WH = W.PATVRlWheel;
  function cue(type) {
    // (the wheel's own events, at the moments they happen on screen: launch, drop, diamond, rotor, hop, settle)
    sound("rl_" + type);
  }
  if (WH && WH.mount && canvas && canvas.getContext) {
    wheel = WH.mount(canvas, { palette: "classic", tilt: wide.matches ? 38 : 0, onEvent: cue, reduced: quick ? true : undefined });
    on(wide, "change", function () {
      if (wheel) wheel.setTilt(wide.matches ? 38 : 0);
    });
  }
  // O13(12): a phone's floating mini wheel while a spin (or its result) is up and the big wheel is scrolled away
  var floatBox = $("rl-float"),
    bowl = $("rl-bowl"),
    bowlSeen = true;
  if (WH && WH.mount && floatBox && W.IntersectionObserver && bowl) {
    var fc = floatBox.querySelector("canvas");
    if (fc && fc.getContext) floater = WH.mount(fc, { compact: true, palette: "classic", reduced: quick ? true : undefined });
    new W.IntersectionObserver(function (es) {
      bowlSeen = es.length ? es[es.length - 1].isIntersecting : true;
      floatShown();
    }).observe(bowl);
  }
  // (review: it takes its own taps - a tap on it never bets on the number under it - and brings the big wheel back into view)
  on(floatBox, "click", function (e) {
    if (e && e.preventDefault) e.preventDefault();
    if (bowl && bowl.scrollIntoView) bowl.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
  });
  function floatShown() {
    if (!floatBox) return;
    var t = last && last.table,
      live = !!t && t.status === "open" && (t.phase === "spinning" || t.phase === "result");
    floatBox.hidden = !(floater && live && !bowlSeen && narrow.matches);
  }
  function drive(w, t) {
    if (!w) return;
    w.setSkew(CZ.skew());
    if (t.status === "open" && t.phase === "spinning" && t.spin) w.spin(t);
    else if (t.status === "open" && t.phase === "result" && t.last_round && typeof t.last_round.number === "number") w.rest(t.last_round.number);
    else w.idle();
  }

  // ── the layout ──
  function choose(n) {
    if (mode === "nb") {
      neighbours(n);
      return;
    }
    if (!compact.matches || mode === "straight") {
      if (controls.place(String(n))) sound("chip");
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
    if (controls.place(matches[0].token)) sound("chip");
  }
  function setMode(k) {
    mode = k;
    first = null;
    $("rl-instruction").textContent =
      k === "nb" ? T("rl_nb_pick", "Pick a number: it and the two numbers either side of it on the wheel, one chip each.") : "";
    Array.from($("rl-modes").children).forEach(function (e) {
      e.setAttribute("aria-pressed", String(e.dataset.mode === k));
    });
    var nb = $("rl-nb");
    if (nb) nb.setAttribute("aria-pressed", String(k === "nb"));
  }
  Object.keys(names).forEach(function (k) {
    var b = doc.createElement("button");
    b.type = "button";
    b.textContent = names[k];
    b.dataset.mode = k;
    b.setAttribute("aria-pressed", String(mode === k));
    b.onclick = function () {
      setMode(k);
    };
    $("rl-modes").append(b);
  });
  var covered = [];
  /** O7 / O13(5): the numbers a spot covers lit on the felt, and its line - what it pays, its cap, my bet */
  function preview(token) {
    unpreview();
    var p = G.positions[token];
    if (!p) return;
    previewed = token;
    p.nums.forEach(function (n) {
      (nodes[String(n)] || []).forEach(function (b) {
        b.classList.add("cov");
        covered.push(b);
      });
    });
    var tip = $("rl-tip");
    if (tip) tip.textContent = spotLine(token);
    if (controls) controls.hover(token);
  }
  function unpreview() {
    covered.forEach(function (b) {
      b.classList.remove("cov");
    });
    covered = [];
    previewed = null;
    var tip = $("rl-tip");
    if (tip) tip.textContent = "";
    if (controls) controls.hover(null);
  }
  /** (a spot's blur / pointer leave: its own preview only - a click on another spot moves the focus after that one's preview began) */
  function unpreviewOf(token) {
    if (previewed === token) unpreview();
  }
  function spot(token, label, cls, parent) {
    var b = doc.createElement("button"),
      p = G.positions[token];
    b.type = "button";
    b.dataset.token = token;
    b.className = cls;
    b.textContent = label;
    parent.append(b);
    var stk = doc.createElement("span");
    stk.className = "rl-stk";
    stk.setAttribute("aria-hidden", "true");
    b.append(stk);
    nodes[token] = nodes[token] || [];
    nodes[token].push(b);
    stks[token] = stks[token] || [];
    stks[token].push(stk);
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
    b.onpointerleave = function () {
      cancel();
      unpreviewOf(token);
    };
    b.onpointerenter = function (e) {
      if (e.pointerType === "mouse") preview(token);
    };
    b.onpointercancel = cancel;
    // (review: the keyboard's focus previews; a tap that focuses the button - Android, Windows touch - never leaves it lit as covered)
    b.onfocus = function () {
      if (!pointerNow()) preview(token);
    };
    b.onblur = function () {
      unpreviewOf(token);
    };
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
      else if (controls.place(token)) sound("chip");
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
  // the outside bets under the numbers as a real felt has them: the dozens under four columns each, the even-money bets under two
  // (desktop: the number grid's own columns; a phone: three across) - [token, desktop column, row, phone column, row]
  var OUT = [
    ["d1", "2 / span 4", "1", "1", "1"],
    ["d2", "6 / span 4", "1", "2", "1"],
    ["d3", "10 / span 4", "1", "3", "1"],
    ["low", "2 / span 2", "2", "1", "2"],
    ["even", "4 / span 2", "2", "2", "2"],
    ["red", "6 / span 2", "2", "3", "2"],
    ["black", "8 / span 2", "2", "1", "3"],
    ["odd", "10 / span 2", "2", "2", "3"],
    ["high", "12 / span 2", "2", "3", "3"],
  ];
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
      var sym = doc.createElement("span");
      sym.className = "symbol";
      sym.textContent = color(n) === "red" ? "◆" : "●";
      b.append(sym);
    }
    for (var k = 1; k <= 3; k++) cell("c" + k, "2:1", "col", "14", String(4 - k), String(k), "14");
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
    var label = {};
    R.outside.forEach(function (p) {
      label[p[0]] = p[1];
    });
    OUT.forEach(function (o) {
      var b = spot(o[0], label[o[0]], "rl-o " + (o[0][0] === "d" ? "dozen" : o[0]), out);
      b.style.gridColumn = o[1];
      b.style.gridRow = o[2];
      b.style.setProperty("--mobile-col", o[3]);
      b.style.setProperty("--mobile-row", o[4]);
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

  // ── chips on the layout (D5): everyone's, from the charged lines only (t.felt totals + seats[i].chips); mine in denomination
  // chips with a gold ring, the others as small chips in their seat's colour (the ring on their avatar), a total and a player count.
  // Chips placed and not yet answered (the batch, the line in flight) show as mine, dimmed. ──
  var SEAT_COLORS = ["#4fc3f7", "#ff8a65", "#ce93d8", "#81c784", "#ffd54f", "#f48fb1", "#4db6ac", "#b39ddb"];
  function seatColor(i) {
    return SEAT_COLORS[i % SEAT_COLORS.length];
  }
  function mySeat(d) {
    var me = d && d.me;
    return me && me.seat ? (d.table.seats || []).find(function (s) {
      return s.seat === me.seat;
    }) || null : null;
  }
  /** token -> {mine, others: [[seatIndex, amount]], total, k} for what the felt shows now */
  function layoutOf(d) {
    var t = d.table,
      me = d.me,
      res = {},
      seats = t.seats || [],
      own = mySeat(d);
    function at(k) {
      return (res[k] = res[k] || { mine: 0, others: [], total: 0, k: 0, wait: 0 });
    }
    (t.felt || []).forEach(function (f) {
      var r = at(f.t);
      r.total = f.n;
      r.k = f.k;
    });
    seats.forEach(function (s, i) {
      (s.chips || []).forEach(function (c) {
        if (own && s === own) at(c[0]).mine += c[1];
        else at(c[0]).others.push([i, c[1]]);
      });
    });
    // (an older server with no felt: my own lines only, as before)
    if (!t.felt && me)
      R.parseSlip(
        (me.lines || [])
          .map(function (l) {
            return l.text;
          })
          .join(" · "),
      ).forEach(function (b) {
        var r = at(b.token);
        r.mine += b.amount;
        r.total += b.amount;
        r.k = 1;
      });
    // the batch and the line in flight count only toward a spin that is taking bets (while it spins they're the next spin's)
    if (t.phase === "betting" || t.phase === "idle")
      unpaid.forEach(function (b) {
        at(b.b).wait += Number(b.a) || 0;
      });
    return res;
  }
  // the denominations a pile is drawn in (casino-ui.js DENOMS / HR_DENOMS: contract 9's chip classes), biggest first
  var DEN = [[25000, "c25k"], [5000, "c5k"], [1000, "c1k"], [500, "c500"], [100, ""], [1, ""]],
    HDEN = [[5000000, "c5m hrc"], [1000000, "c1m hrc"], [500000, "c500k hrc"], [100000, "c100k hrc"]];
  function breakdown(n, hr, most) {
    var list = [],
      left = Math.max(0, Math.trunc(n));
    (hr ? HDEN.concat(DEN) : DEN).forEach(function (d) {
      while (left >= d[0] && list.length < most) {
        list.push(d[1]);
        left -= d[0];
      }
    });
    return list.length ? list : [""];
  }
  /** ONE pile per spot (O10): the others' chips at the bottom in their seats' colours, mine on top in denomination chips (the top
   *  one ringed in gold), then the spot's total and - with more than one player on it - the player count */
  function stackFor(token, r, hr, cls) {
    var mine = r.mine + r.wait,
      others = showOthers ? r.others.slice().sort(function (a, b) {
        return b[1] - a[1];
      }).slice(0, mine ? 2 : 3) : [],
      chips = [];
    others.forEach(function (o) {
      chips.push('<span class="chip rl-oc" style="--c:' + seatColor(o[0]) + ";--e:rgba(255,255,255,.9);--i:" + chips.length + '"></span>');
    });
    if (mine)
      breakdown(mine, hr, 3)
        .reverse()
        .forEach(function (c, i, all) {
          chips.push('<span class="chip ' + c + (i === all.length - 1 ? " rl-top" : "") + '" style="--i:' + chips.length + '"></span>');
        });
    var html = chips.length ? '<span class="pile' + (r.wait && !r.mine ? " await" : "") + '" style="--n:' + chips.length + '">' + chips.join("") + "</span>" : "",
      total = showOthers ? r.total + r.wait : mine;
    if (total) html += '<b class="rl-amt">' + CZ.esc(CZ.short(total)) + "</b>";
    if (showOthers && r.k > 1) html += '<i class="rl-k">' + r.k + "</i>";
    return { html: html, cls: "rl-stk" + (cls ? " " + cls : "") + (mine ? " mine" : "") + (html ? " on" : "") };
  }
  /** the spot's spoken name and the hover / focus line: the felt's words, what it pays, its cap, my bet (and everyone's) */
  function spotLine(token, r) {
    var p = G.positions[token];
    if (!p) return token;
    r = r || (last ? layoutOf(last)[token] : null) || { mine: 0, total: 0, k: 0, wait: 0 };
    var s = T("rl_spot_aria", "{spot} · {kind} · pays {odds} to 1 · up to {cap} PAT · your bet {n} PAT", {
      spot: spotWords(token),
      kind: kinds[p.kind] || T("rl_even_money", "Even money"),
      odds: p.odds,
      cap: CZ.fmt(controls ? controls.capOf(token) : 0),
      n: CZ.fmt(r.mine + r.wait),
    });
    if (showOthers && r.total && r.k) {
      s +=
        " · " +
        T("rl_spot_all", { "one": "{pat} PAT on it from {k} player", "other": "{pat} PAT on it from {k} players" }, {
          pat: CZ.fmt(r.total),
          k: r.k,
          count: r.k,
        });
      // (who: the other seats' names - a masked seat by its label - and their chips, the biggest first)
      var seats = (last && last.table.seats) || [],
        who = (r.others || [])
          .slice()
          .sort(function (a, b) {
            return b[1] - a[1];
          })
          .map(function (o) {
            return seats[o[0]] ? seats[o[0]].name + " " + CZ.fmt(o[1]) : "";
          })
          .filter(Boolean);
      if (who.length > 4) who = who.slice(0, 4).concat(T("rl_more_n", "+{n} more", { n: who.length - 4 }));
      if (who.length) s += " " + T("rl_spot_players", "({names})", { names: who.join(", ") });
    }
    return s;
  }
  var painted = Object.create(null);
  function paintChips() {
    if (!last) return;
    var d = last,
      t = d.table,
      hr = !!(t.high_stakes || (d.me && d.me.high_roller)),
      lay = layoutOf(d),
      result = t.status === "open" && t.phase === "result" && t.last_round && typeof t.last_round.number === "number" ? t.last_round.number : null;
    Object.keys(nodes).forEach(function (token) {
      var r = lay[token] || { mine: 0, others: [], total: 0, k: 0, wait: 0 },
        p = G.positions[token],
        hit = result !== null && p.nums.indexOf(result) >= 0,
        fate = result === null ? "" : hit ? "hit" : "lost",
        s = stackFor(token, r, hr, fate && (r.total || r.mine || r.wait) ? fate : ""),
        label = spotLine(token, r),
        sig = s.cls + "|" + s.html + "|" + label + "|" + fate + "|" + (result === +token ? 1 : 0);
      if (painted[token] === sig) return;
      painted[token] = sig;
      // (review: the line under the board follows the chips just placed on the spot being hovered / focused)
      if (previewed === token && $("rl-tip")) $("rl-tip").textContent = label;
      stks[token].forEach(function (el) {
        el.className = s.cls;
        el.innerHTML = s.html;
      });
      nodes[token].forEach(function (b) {
        b.setAttribute("aria-label", label);
        if (!compact.matches || !b.classList.contains("edge")) b.title = label;
        b.classList.toggle("hit", !!hit);
        b.classList.toggle("won", result !== null && p.kind === "straight" && result === +token);
        b.classList.toggle("awaiting", !!r.wait);
      });
    });
  }

  /** the layout's players and PAT as the felt shows them (D5: the seats' chips - while the result is up, the spin that landed) */
  function onLayout(t) {
    if (!t.felt) return { players: t.totals.players, pat: t.totals.staked };
    var on = (t.seats || []).filter(function (s) {
      return s.staked > 0;
    });
    return {
      players: on.length,
      pat: on.reduce(function (a, s) {
        return a + s.staked;
      }, 0),
    };
  }
  // ── the players rail (O10): everyone on this spin, the biggest stake first - avatar (the person menu), name, stake, net at the
  // result; a ring in the seat's colour matches their chips on the layout. Masked seats show their label and a frog. ──
  // (its head is built once - the Others' bets toggle keeps the focus while the list under it changes)
  var railHead = doc.createElement("div"),
    railSum = doc.createElement("span"),
    railList = doc.createElement("ol"),
    othersBtn = doc.createElement("button");
  railHead.className = "rl-ph";
  var railLbl = doc.createElement("span");
  railLbl.className = "felt-lbl";
  railLbl.textContent = T("rl_players", "Players");
  othersBtn.type = "button";
  othersBtn.className = "cz-btn ghost sm rl-otbtn";
  othersBtn.id = "rl-others";
  othersBtn.textContent = T("rl_show_others", "Others' bets");
  railHead.append(railLbl, railSum, othersBtn);
  railList.className = "rl-seats";
  if ($("rl-players")) $("rl-players").append(railHead, railList);
  var rows = new Map(),
    railExtra = doc.createElement("li");
  /** a seat's row, made once: its .who (the person-menu button, redrawn only when the name or tags change) and, beside it, the stake */
  function railRow(key) {
    var row = rows.get(key);
    if (row) return row;
    var li = doc.createElement("li"),
      who = doc.createElement("div"),
      bet = doc.createElement("div");
    li.dataset.seat = key;
    who.className = "who";
    bet.className = "rl-sbet";
    li.append(who, bet);
    row = { li: li, who: who, bet: bet, wv: null, bv: null };
    rows.set(key, row);
    return row;
  }
  function renderPlayers(t, me) {
    var box = $("rl-players");
    if (!box) return;
    var seats = (t.seats || []).map(function (s, i) {
      return { s: s, i: i };
    });
    seats.sort(function (a, b) {
      return (b.s.staked || 0) - (a.s.staked || 0) || a.i - b.i;
    });
    var max = narrow.matches ? 8 : 14,
      hr = !!(t.high_stakes || (me && me.high_roller)),
      result = t.phase === "result",
      lay = onLayout(t),
      shownSeats = seats.slice(0, max);
    railSum.textContent = T("rl_layout_n", { "one": "Layout: {players} player · {pat} PAT", "other": "Layout: {players} players · {pat} PAT" }, {
      players: lay.players,
      pat: CZ.fmt(lay.pat),
      count: lay.players,
    });
    othersBtn.setAttribute("aria-pressed", String(showOthers));
    var order = [],
      keep = Object.create(null);
    shownSeats.forEach(function (x) {
      var s = x.s,
        key = String(s.seat),
        mine = !!(me && me.seat && s.seat === me.seat),
        net = result && typeof s.net === "number" ? s.net : null,
        // (review: a seat with nothing on this spin is dimmed and says so - the rail's head counts only the bettors)
        out = !(s.staked > 0),
        row = railRow(key);
      keep[key] = 1;
      var cls = "seat" + (mine ? " me" : "") + (net > 0 ? " winner" : "") + (out ? " out" : "");
      if (row.li.className !== cls) row.li.className = cls;
      row.li.style.setProperty("--sc", seatColor(x.i));
      var wv = CZ.seatWho(
        s,
        CZ.avatarHTML(s) +
          '<span class="plate"><span class="nm">' +
          CZ.esc(s.name) +
          (mine ? " · " + CZ.esc(T("you", "you")) : "") +
          "</span>" +
          (s.host ? '<span class="tags"><span class="tag gold">👑 ' + CZ.esc(T("host", "host")) + "</span></span>" : "") +
          "</span>",
      );
      if (row.wv !== wv) {
        row.wv = wv;
        row.who.innerHTML = wv;
      }
      var bv =
        (s.staked
          ? '<span class="sub">' + CZ.stackHTML(s.staked, T("rl_stake_lbl", "On the layout {n} PAT", { n: CZ.fmt(s.staked) }), hr) + "</span>"
          : '<span class="sub rl-out">' + CZ.esc(T("rl_sitting_out", "No bet this spin")) + "</span>") +
        (net !== null && net !== 0 ? '<span class="sub rl-pnet">' + CZ.net(net) + "</span>" : "");
      if (row.bv !== bv) {
        row.bv = bv;
        row.bet.innerHTML = bv;
      }
      order.push(row.li);
    });
    rows.forEach(function (row, key) {
      if (keep[key]) return;
      if (row.li.parentNode) row.li.remove();
      rows.delete(key);
    });
    var extra = "";
    if (seats.length > max) {
      railExtra.className = "rl-more-n";
      extra = T("rl_more_n", "+{n} more", { n: seats.length - max });
    } else if (!seats.length) {
      railExtra.className = "rl-none";
      extra = t.phase === "betting" || t.phase === "idle" ? T("rl_no_bets", "No bets yet this spin.") : T("rl_no_players", "Nobody played this spin.");
    }
    if (extra) {
      if (railExtra.textContent !== extra) railExtra.textContent = extra;
      order.push(railExtra);
    } else if (railExtra.parentNode) railExtra.remove();
    // the order (the biggest stake first) - rows move only while nothing in the rail has the focus and no person menu is open
    // (a moved button drops the focus; an open menu keeps its anchor); new rows join at the end meanwhile
    var held =
        !!(doc.activeElement && railList.contains && railList.contains(doc.activeElement)) ||
        !!(doc.querySelector && doc.querySelector(".pm-pop")),
      kids = railList.children,
      same = kids.length === order.length;
    for (var i = 0; same && i < order.length; i++) same = kids[i] === order[i];
    if (!same)
      order.forEach(function (n) {
        if (held && n.parentNode === railList) return;
        if (n.parentNode) n.remove();
        railList.append(n);
      });
  }
  on(othersBtn, "click", function () {
    showOthers = !showOthers;
    store.set("localStorage", "rl-others", showOthers ? "1" : "0");
    painted = Object.create(null);
    if (last) render(last);
  });

  // ── the result moment (O13(2)): the winning number and every covering spot glow (paintChips' hit / won classes); losing chips are
  // raked toward the wheel, winners get a pop, a straight-up hit gets a small gold burst - none of the motion under reduced motion,
  // and only for a result that lands while the page is open ──
  function celebrate(t, me) {
    var n = t.last_round.number,
      board = $("rl-board");
    if (reduced()) return;
    (nodes[String(n)] || []).forEach(function (b) {
      b.classList.add("pulse");
      setTimeout(function () {
        b.classList.remove("pulse");
      }, 3700);
    });
    if (board) {
      board.classList.add("raking");
      setTimeout(function () {
        board.classList.remove("raking");
      }, 1400);
    }
    var lay = last ? layoutOf(last) : {},
      straight = lay[String(n)];
    if (straight && (straight.total || straight.mine)) {
      var cellEl = (nodes[String(n)] || [])[0];
      if (cellEl) {
        var burst = doc.createElement("span");
        burst.className = "rl-burst";
        burst.setAttribute("aria-hidden", "true");
        for (var i = 0; i < 10; i++) {
          var sp = doc.createElement("i");
          sp.style.setProperty("--a", i * 36 + "deg");
          burst.append(sp);
        }
        cellEl.append(burst);
        setTimeout(function () {
          burst.remove();
        }, 1300);
      }
    }
    setTimeout(function () {
      (t.seats || []).forEach(function (s) {
        if (!(s.net > 0)) return;
        var row = rows.get(String(s.seat));
        if (row && row.li.parentNode) CZ.pop(row.li, "+" + CZ.fmt(s.net), "win");
      });
      if (me && me.net > 0) {
        Object.keys(lay).forEach(function (k) {
          if (lay[k].mine && G.positions[k].nums.indexOf(n) >= 0) (nodes[k] || []).slice(0, 1).forEach(function (b) {
            CZ.pop(b, "+" + CZ.short(lay[k].mine * G.positions[k].odds), "win");      // (what the spot won: its odds)
          });
        });
      }
    }, 350);
  }

  // ── Pepe the croupier's line and the felt's clock ──
  function croupier(t, me) {
    var msg = "",
      sub = "",
      dl = null,
      nom = 0,
      Rl = R.rulesOf(t),
      now = Date.now() - CZ.skew();
    if (t.status !== "open") msg = T("closed", "That table has closed.");
    else if (t.phase === "betting" || t.phase === "idle") {
      var left = t.phase === "betting" && t.deadline ? t.deadline - now : Infinity;
      msg = left <= 5000 ? T("rl_last_bets", "Last bets…") : T("place_bets", "Place your bets");
      sub = t.phase === "idle" || !t.deadline ? T("rl_first_bet", "The clock starts with the first bet.") : T("rl_spin_number", "Spin {n}", { n: t.round_no });
      dl = t.phase === "betting" ? t.deadline : null;
      nom = Rl.bet_secs;
    } else if (t.phase === "spinning") {
      msg = T("rl_spinning", "No more bets");
      sub = T("rl_spin_number", "Spin {n}", { n: t.round_no });
      dl = t.land_at;
      nom = (t.spin && t.spin.secs) || Rl.spin_secs;
    } else if (t.last_round && typeof t.last_round.number === "number") {
      msg = R.pocketLabel(t.last_round.number);
      sub = T("rl_spin_number", "Spin {n}", { n: t.last_round.round_no });
      dl = t.result_until;
      nom = Rl.result_secs;
    }
    var html = CZ.esc(msg) + (sub ? "<small>" + CZ.esc(sub) + "</small>" : ""),
      m = $("cz-msg");
    if (m && m.dataset.v !== html) {
      m.dataset.v = html;
      m.innerHTML = html;
    }
    CZ.armClock($("cz-fclock"), t.status === "open" ? dl : null, nom);
    return msg;
  }
  setInterval(function () {
    if (last) croupier(last.table, last.me);
  }, 500);

  // 1.99aoh: the table's limits in plain words, from the wheel's rules (t.rules: the spin's own limits, D3 - or the rl_* map in
  // t.limits from an older server), every one per player and per spin - and, for a signed-in player while bets are open, what they
  // have on the layout and what is left for them this spin (me.room_left). It folds to its summary line, which keeps the key limits
  // and the "left" meter in sight.
  var limitsBox = doc.createElement("details"),
    limitsHead = doc.createElement("summary"),
    limitsTitle = doc.createElement("span"),
    limitsKey = doc.createElement("span"),
    limitsLeft = doc.createElement("span"),
    limitsList = doc.createElement("ul");
  limitsBox.className = "rl-limits";
  limitsBox.id = "rl-limits";
  limitsBox.hidden = true;
  // (folded by default - its summary keeps the minimum, the straight cap and the spin's maximum in sight; this viewer's choice is kept)
  limitsBox.open = store.get("localStorage", "rl-limits-open") === "1";
  on(limitsBox, "toggle", function () {
    store.set("localStorage", "rl-limits-open", limitsBox.open ? "1" : "0");
  });
  limitsTitle.className = "rl-limits-h";
  limitsTitle.textContent = T("rl_limits", "Table limits");
  limitsKey.className = "rl-lim-key";
  limitsLeft.className = "rl-left";
  limitsHead.append(limitsTitle, limitsKey, limitsLeft);
  limitsBox.append(limitsHead, limitsList);
  $("rl-modes").before(limitsBox);
  function placard(t, me) {
    var L = t.limits || {};
    if (!(t.rules && t.rules.caps) && !(L.rl_min_bet && L.rl_max_spin)) {
      limitsBox.hidden = true;
      return;
    }
    var Rl = R.rulesOf(t),
      C = Rl.caps;
    limitsBox.hidden = false;
    var key = [Rl.min, C.straight, C.split, C.street, C.corner, C.line, C.outside, Rl.max_spin, Rl.max_positions].join(",");
    if (limitsList.dataset.key !== key) {
      limitsList.dataset.key = key;
      limitsList.replaceChildren();
      var n = function (v) {
        return { n: CZ.fmt(v) };
      };
      [
        [T("rl_lim_spin", "All your bets together: up to {n} PAT a spin", n(Rl.max_spin)), "rl-lim-spin"],
        [T("rl_lim_min", "Minimum bet: {n} PAT each time you bet", n(Rl.min))],
        [T("rl_lim_straight", "One number (straight up): up to {n} PAT", n(C.straight))],
        [T("rl_lim_split", "Split, 2 numbers: up to {n} PAT", n(C.split))],
        [T("rl_lim_street", "Street or trio, 3 numbers: up to {n} PAT", n(C.street))],
        [T("rl_lim_corner", "Corner or first four, 4 numbers: up to {n} PAT", n(C.corner))],
        [T("rl_lim_line", "Line, 6 numbers: up to {n} PAT", n(C.line))],
        [T("rl_lim_outside", "Dozens, columns, red or black, odd or even, 1–18 or 19–36: up to {n} PAT each", n(C.outside))],
        [Rl.max_positions ? T("rl_lim_spots", "Up to {n} spots a spin", n(Rl.max_positions)) : ""],
        [T("rl_lim_note", "Every limit is per player and per spin. A spot's limit counts all your chips on that spot."), "rl-lim-note"],
      ].forEach(function (row) {
        if (!row[0]) return;
        var li = doc.createElement("li");
        li.textContent = row[0];
        if (row[1]) li.className = row[1];
        limitsList.append(li);
      });
      limitsKey.textContent = T("rl_lim_key", "Min {min} · straight up to {straight} · up to {spin} PAT a spin per player", {
        min: CZ.fmt(Rl.min),
        straight: CZ.fmt(C.straight),
        spin: CZ.fmt(Rl.max_spin),
      });
    }
    var open = t.status === "open" && (t.phase === "idle" || t.phase === "betting");
    limitsLeft.textContent =
      me && !me.banned && open && typeof me.room_left === "number"
        ? T("rl_left", "Your bets this spin: {staked} PAT · {left} PAT left", {
            staked: CZ.fmt(me.staked || 0),
            left: CZ.fmt(me.room_left),
          })
        : "";
  }

  // ── the tags under the felt, the spectator ribbon ──
  function meta(t) {
    var rs = t.rooms && t.rooms.length ? t.rooms.map(function (r) {
      return r.name;
    }) : t.room ? [t.room_name || t.room] : [];
    var where = rs.length
      ? "🐸 " + CZ.esc(rs.length > 1 ? T("in_rooms", "Chat rooms {rooms}", { rooms: rs.join(", ") }) : T("in_room", "Chat room {room}", { room: rs[0] }))
      : "🌐 " + CZ.esc(T("web_only", "Web only"));
    var tags = [
      t.high_stakes ? ["hr", "💎 " + CZ.esc(T("high_roller", "High Roller"))] : null,
      ["", t.lobby ? "🛞 " + CZ.esc(T("rl_lobby", "Lobby wheel")) : "👑 " + CZ.esc(t.host || "")],
      ["", where],
      t.round_no ? ["", CZ.esc(T("rl_spin_number", "Spin {n}", { n: t.round_no }))] : null,
      t.on_stream ? ["red", "📺 " + CZ.esc(T("on_stream", "On Pepe's stream"))] : t.stream_queue ? ["", "📺 " + CZ.esc(T("stream_q", "stream queue #{n}", { n: t.stream_queue }))] : null,
    ]
      .filter(Boolean)
      .map(function (x) {
        return '<span class="tag' + (x[0] ? " " + x[0] : "") + '">' + x[1] + "</span>";
      })
      .join("");
    var el = $("cz-meta");
    if (el && el.dataset.v !== tags) {
      el.dataset.v = tags;
      el.innerHTML = tags;
    }
  }
  function watchbar(t, me) {
    var wb = $("cz-watchbar");
    if (!wb) return;
    var txt = "";
    // UI-6 / O9: a signed-out viewer watches - say so, with the way in (the blackjack table's words)
    if (t.status === "open" && !CZ.signed)
      txt = "👁 " + CZ.esc(T("watching_signin", "You're watching.")) + ' <a href="/login">' + CZ.esc(T("signin_play", "Sign in to play")) + "</a>";
    else if (t.status === "open" && me && me.banned) txt = CZ.esc(T("banned", "You're banned from the casino."));
    else if (t.status === "open" && me && t.high_stakes && !me.high_roller)
      txt = "💎 " + CZ.esc(T("rl_watch_hr", "A High Roller wheel: you're watching. Only High Rollers can bet here.")) + ' <a href="/shop">' + CZ.esc(T("hr_get", "Get the role")) + "</a>";
    wb.hidden = !txt;
    if (wb.dataset.v !== txt) {
      wb.dataset.v = txt;
      wb.innerHTML = txt;
    }
  }

  // ── O13(10): this browser tab's session line (sessionStorage; nothing leaves the page) ──
  var SKEY = "rl-session-v1",
    sess = null;
  function session(t, me) {
    // (read once; kept in memory too - blocked storage counts for this page only)
    var s = sess;
    if (!s) {
      try {
        s = JSON.parse(store.get("sessionStorage", SKEY) || "null");
      } catch (_) {
        s = null;
      }
      if (!s || typeof s !== "object" || !Array.isArray(s.seen) || !(s.spins >= 0) || typeof s.net !== "number") s = { spins: 0, net: 0, seen: [] };
      sess = s;
    }
    if (t.phase === "result" && t.last_round && me && typeof me.net === "number") {
      var key = t.id + ":" + t.last_round.round_no;
      if (s.seen.indexOf(key) < 0) {
        s.seen = s.seen.concat(key).slice(-60);
        s.spins += 1;
        s.net += me.net;
        store.set("sessionStorage", SKEY, JSON.stringify(s));
        // (another tab of this session may have counted too: it keeps its own page's count)
      }
    }
    var el = $("rl-session");
    if (el)
      el.textContent = s.spins
        ? T("rl_session", { "one": "This session: {n} spin · net {net} PAT", "other": "This session: {n} spins · net {net} PAT" }, {
            n: s.spins,
            net: (s.net > 0 ? "+" : s.net < 0 ? "−" : "±") + CZ.fmt(Math.abs(s.net)),
            count: s.spins,
          })
        : "";
  }

  // ── O13(9): the stats drawer - the last spins' counts, always labelled that each spin is independent (no hot / cold / due) ──
  function stats(t) {
    var box = $("rl-stats-b");
    if (!box) return;
    var h = (t.history || []).map(function (r) {
        return r.number;
      }),
      n = h.length,
      cnt = function (f) {
        return h.filter(f).length;
      };
    var groups = [
      [T("rl_st_colour", "Colour"), [[R.outside[2][1], cnt(function (x) {
        return x && G.red.indexOf(x) >= 0;
      })], [R.outside[3][1], cnt(function (x) {
        return x && G.red.indexOf(x) < 0;
      })], ["0", cnt(function (x) {
        return x === 0;
      })]]],
      [T("rl_st_parity", "Odd or even"), [[R.outside[4][1], cnt(function (x) {
        return x && x % 2;
      })], [R.outside[1][1], cnt(function (x) {
        return x && !(x % 2);
      })]]],
      [T("rl_st_half", "Low or high"), [["1–18", cnt(function (x) {
        return x >= 1 && x <= 18;
      })], ["19–36", cnt(function (x) {
        return x >= 19;
      })]]],
      [T("rl_dozen", "Dozen"), [1, 2, 3].map(function (k) {
        return [felt["d" + k], cnt(function (x) {
          return x && Math.ceil(x / 12) === k;
        })];
      })],
      [T("rl_column", "Column"), [1, 2, 3].map(function (k) {
        return [felt["c" + k], cnt(function (x) {
          return x && ((x - 1) % 3) + 1 === k;
        })];
      })],
    ];
    var html =
      '<p class="rl-indep">' + CZ.esc(T("rl_st_indep", "Each spin is independent: these counts say nothing about the next spin.")) + "</p>" +
      '<p class="fine">' + CZ.esc(T("rl_st_n", { "one": "The last {n} spin on this wheel.", "other": "The last {n} spins on this wheel." }, { n: n, count: n })) + "</p>" +
      groups
        .map(function (g) {
          return (
            '<div class="rl-stg"><b>' + CZ.esc(g[0]) + "</b>" +
            g[1]
              .map(function (row) {
                var pct = n ? Math.round((100 * row[1]) / n) : 0;
                return '<div class="rl-str"><span>' + CZ.esc(row[0]) + '</span><span class="rl-bar"><i style="width:' + pct + '%"></i></span><span>' + CZ.fmt(row[1]) + "</span></div>";
              })
              .join("") +
            "</div>"
          );
        })
        .join("");
    if (box.dataset.v !== html) {
      box.dataset.v = html;
      box.innerHTML = html;
    }
  }
  // O11: a per-viewer ⚡ Quick spin - the ball simply fades into its pocket at the landing (the wheel's reduced-motion path), and the
  // result moment keeps its highlight without the motion; remembered in this browser
  var quickBtn = $("rl-quick");
  function paintQuick() {
    if (quickBtn) quickBtn.setAttribute("aria-pressed", String(quick));
    var cb = $("cb");
    if (cb) cb.classList.toggle("rl-quick", quick);
  }
  paintQuick();
  on(quickBtn, "click", function () {
    quick = !quick;
    store.set("localStorage", "rl-quick", quick ? "1" : "0");
    paintQuick();
    // (null: back to following prefers-reduced-motion)
    if (wheel && wheel.setReduced) wheel.setReduced(quick ? true : null);
    if (floater && floater.setReduced) floater.setReduced(quick ? true : null);
  });
  var keysBtn = $("rl-keys");
  function paintKeys() {
    if (keysBtn) keysBtn.setAttribute("aria-pressed", String(keysOn));
    if (controls && controls.keys) controls.keys(keysOn);
  }
  on(keysBtn, "click", function () {
    keysOn = !keysOn;
    store.set("localStorage", "rl-keys", keysOn ? "1" : "0");
    paintKeys();
  });
  on($("rl-statsbtn"), "click", function () {
    if (last) stats(last.table);
    CZ.openSheet("rl-stats");
  });

  // ── D8 call bets (O13(6)): web shortcuts that expand into ordinary positions sent as ONE line (the server sees a normal bet:
  // its limits, its refusals, its idempotency key) - a unit is the chip selected in the rack ──
  var WHEEL = (W.PATVRlWheel && W.PATVRlWheel.WHEEL) || [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  var CALLS = {
    // Voisins du zéro (the 17 numbers around zero): 0-2-3 and 25-26-28-29 two units each, five splits one each - 7 positions, 9 units
    voisins: [["0-2-3", 2], ["4-7", 1], ["12-15", 1], ["18-21", 1], ["19-22", 1], ["32-35", 1], ["25-26-28-29", 2]],
    // Tiers du cylindre (the 12 numbers opposite zero): six splits - 6 units
    tiers: [["5-8", 1], ["10-11", 1], ["13-16", 1], ["23-24", 1], ["27-30", 1], ["33-36", 1]],
    // Orphelins (the other 8): 1 straight, four splits - 5 units
    orphelins: [["1", 1], ["6-9", 1], ["14-17", 1], ["17-20", 1], ["31-34", 1]],
  };
  // (the section's own spoken name and the numbers it covers - the hover preview lights them)
  function callNums(list) {
    var s = [];
    list.forEach(function (c) {
      G.positions[c[0]].nums.forEach(function (n) {
        if (s.indexOf(n) < 0) s.push(n);
      });
    });
    return s;
  }
  function callPairs(list) {
    var unit = controls.chip();
    return list.map(function (c) {
      return { b: c[0], a: String(unit * c[1]) };
    });
  }
  function neighbours(n) {
    var i = WHEEL.indexOf(n),
      list = [-2, -1, 0, 1, 2].map(function (d) {
        return [String(WHEEL[(i + d + 37) % 37]), 1];
      });
    setMode("straight");
    if (controls.placeMany(callPairs(list))) sound("chip");
  }
  function lightNums(nums, owner) {
    unpreview();
    previewed = owner || null;
    nums.forEach(function (n) {
      (nodes[String(n)] || []).forEach(function (b) {
        b.classList.add("cov");
        covered.push(b);
      });
    });
  }
  function buildRace() {
    var box = $("rl-race");
    if (!box) return;
    var label = {
      voisins: [T("rl_voisins", "Voisins du zéro")],
      tiers: [T("rl_tiers", "Tiers")],
      orphelins: [T("rl_orphelins", "Orphelins")],
    };
    Object.keys(label).forEach(function (k) {
      label[k][1] = CALLS[k].reduce(function (a, c) {
        return a + c[1];
      }, 0);
    });
    var h = doc.createElement("span");
    h.className = "felt-lbl";
    h.textContent = T("rl_calls", "Call bets");
    box.append(h);
    Object.keys(CALLS).forEach(function (k) {
      var b = doc.createElement("button");
      b.type = "button";
      b.className = "rl-call";
      b.dataset.call = k;
      b.textContent = label[k][0];
      var u = doc.createElement("small");
      u.textContent = T("rl_units", { "one": "{n} chip", "other": "{n} chips" }, { n: label[k][1], count: label[k][1] });
      b.append(u);
      b.setAttribute("aria-label", T("rl_call_label", "{name}: {n} chips on the numbers {nums}", { name: label[k][0], n: label[k][1], nums: callNums(CALLS[k]).sort(function (x, y) {
        return x - y;
      }).join(", ") }));
      b.onclick = function () {
        if (controls.placeMany(callPairs(CALLS[k]))) sound("chip");
      };
      b.onpointerenter = function (e) {
        if (e.pointerType === "mouse") lightNums(callNums(CALLS[k]), "call:" + k);
      };
      b.onpointerleave = function () {
        unpreviewOf("call:" + k);
      };
      b.onfocus = function () {
        if (!pointerNow()) lightNums(callNums(CALLS[k]), "call:" + k);
      };
      b.onblur = function () {
        unpreviewOf("call:" + k);
      };
      box.append(b);
    });
    var nb = doc.createElement("button");
    nb.type = "button";
    nb.className = "rl-call";
    nb.id = "rl-nb";
    nb.setAttribute("aria-pressed", "false");
    nb.textContent = T("rl_neighbours", "Neighbours ±2");
    var u2 = doc.createElement("small");
    u2.textContent = T("rl_units", { "one": "{n} chip", "other": "{n} chips" }, { n: 5, count: 5 });
    nb.append(u2);
    nb.onclick = function () {
      setMode(mode === "nb" ? "straight" : "nb");
    };
    box.append(nb);
  }

  // ── the sound toggle's cues from the table's own moments (the wheel's ball cues come from its onEvent) ──
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
    controls.update(d);
    var fe = $("cz-felt");
    if (fe) {
      fe.classList.toggle("hr", !!t.high_stakes);
      CZ.theme(t, { scene: fe, sign: null });
    }
    // (a High Roller wheel's ebony and gold, on the big wheel and the phone's floating one)
    if ((previous && !!previous.table.high_stakes !== !!t.high_stakes) || (!previous && t.high_stakes))
      [wheel, floater].forEach(function (w) {
        if (w) w.setPalette(t.high_stakes ? "hr" : "classic");
      });
    drive(wheel, t);
    drive(floater, t);
    floatShown();
    $("cb").classList.toggle("rl-lobby", !!t.lobby);
    $("cb").classList.toggle("rl-spinning", t.phase === "spinning");
    $("cb").classList.toggle("rl-result", t.phase === "result");
    var msg = croupier(t, me);
    var result = t.phase === "result" && t.last_round;
    var net =
      result && me && typeof me.net === "number"
        ? T("rl_net", "Your net {n} PAT", { n: (me.net > 0 ? "+" : me.net < 0 ? "−" : "±") + CZ.fmt(Math.abs(me.net)) })
        : "";
    var netEl = $("rl-net");
    if (netEl) {
      netEl.textContent = net;
      netEl.classList.toggle("win", !!(net && me.net > 0));
    }
    // contract 8: the spin and the result as client events (sound, the phone mini wheel, pops)
    if (t.phase === "spinning" && t.spin && seenSpin !== t.spin.round_no) {
      seenSpin = t.spin.round_no;
      fire("cz:rl-spin", { table: t.id, round: t.spin.round_no, pocket: t.spin.number, startedAt: t.spin.started_at, landAt: t.spin.ends_at });
    }
    var landed = result && typeof t.last_round.number === "number" && seenResult !== t.last_round.round_no;
    if (landed) {
      seenResult = t.last_round.round_no;
      fire("cz:rl-result", { table: t.id, round: t.last_round.round_no, pocket: t.last_round.number, net: me && typeof me.net === "number" ? me.net : null });
    }
    // (the chips were painted by controls.update -> its paint callback, with the batch in flight)
    renderPlayers(t, me);
    // (a result seen land - not the page opening on one: the motion and the bell)
    if (landed && rendered && prevPhase === "spinning") {
      celebrate(t, me);
      if (me && me.net > 0) sound("bell");
    }
    var strip = $("rl-history");
    if (strip.dataset.round !== String(t.last_revealed)) {
      strip.dataset.round = String(t.last_revealed);
      strip.replaceChildren();
      // 1.99aoh: each pocket in the felt's colours (the client's red list, never the entry's server colour field), newest
      // first and larger
      t.history
        .slice(-20)
        .reverse()
        .forEach(function (r, i) {
          var li = doc.createElement("li");
          li.append(R.pocket(r.number, r.round_no, i === 0));
          strip.append(li);
        });
      var sheet = $("rl-stats");
      if (sheet && sheet.open) stats(t);
    }
    placard(t, me);
    meta(t);
    watchbar(t, me);
    var dk = $("cz-dock");
    if (dk) dk.hidden = !CZ.signed || t.status !== "open" || !me || !!(t.high_stakes && !me.high_roller);
    session(t, me);
    CZ.announce((msg && msg !== phase ? phase + " · " + msg : phase) + (net ? " · " + net : ""));
    if (me && me.notice && me.notice.id === "rl_intro")
      CZ.note(
        T(
          "rl_intro",
          "PAT are points with no cash value. Each spin is independent. The wheel has a single zero and straight up pays 35 to 1.",
        ),
      );
    if (me && me.private_note && (!previous || !previous.me || previous.me.private_note !== me.private_note))
      CZ.toast(me.private_note, true);
    prevPhase = t.phase;
    rendered = true;
  }
  var explanation = doc.querySelector("#cz-histsheet .fine");
  if (explanation)
    explanation.textContent = T(
      "rl_fair_how",
      "Each spin is committed before bets open. After the result, open its proof to check the pocket in your browser.",
    );
  paintBoard();
  buildRace();
  controls = R.controls($("cz-dock"), {
    id: CZ.tableId,
    refresh: function () {
      return refresh && refresh();
    },
    paint: function (lines, inFlight) {
      unpaid = inFlight || [];
      paintChips();
    },
  });

  paintKeys();

  // ── O13(8): the keyboard - 1-5 chips, Z undo, C clear, R rebet, D ×2, Space spins now for a sole bettor. Review fixes:
  //   * WCAG 2.1.4: only on this table - the page itself or a control on it (never the navbar, the chat, a person menu or a sheet) -
  //     and the viewer can turn them off (⌨, remembered);
  //   * never while typing, never with a modifier, never a held key's repeats (a held D doubled again and again);
  //   * a button the KEYBOARD focused keeps Space (Tab, then Space presses it); one a mouse click focused (Chrome on Windows) gives
  //     Space to the table - Spin now, never that spot or ×2 again; Space on the page spins only while the board is in view (or
  //     it scrolls, as it always did) ──
  var tableBox = $("cz-table"),
    boardSeen = true,
    spaceEaten = false;
  if (W.IntersectionObserver && $("rl-board"))
    new W.IntersectionObserver(function (es) {
      boardSeen = es.length ? es[es.length - 1].isIntersecting : true;
    }).observe($("rl-board"));
  function onTable(el) {
    if (!el || el === doc.body || el === doc.documentElement) return true;
    if (el.closest && el.closest('.pm-pop,[role="menu"],[role="dialog"],dialog')) return false;
    return !!(tableBox && tableBox.contains && tableBox.contains(el));
  }
  doc.addEventListener("keydown", function (e) {
    if (String(e.key || "") === " " && !e.repeat) spaceEaten = false;      // (a keyup lost to a window switch never eats a later one)
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || !keysOn) return;
    var k = String(e.key || ""),
      verb = /^[1-5]$/.test(k) ? "chip" : { z: "undo", c: "clear", r: "rebet", d: "double", " ": "go" }[k.toLowerCase()];
    if (!verb) return;
    var tg = e.target || {},
      tag = String(tg.tagName || "");
    if (/^(?:INPUT|SELECT|TEXTAREA)$/.test(tag) || tg.isContentEditable) return;
    if (doc.querySelector && doc.querySelector("dialog[open]")) return;
    if (!onTable(tg)) return;
    var control = /^(?:BUTTON|A|SUMMARY)$/.test(tag);
    if (verb === "go" && control && tg !== pointerFocus) return;
    if (e.repeat) {
      if (verb !== "go" || control) e.preventDefault();
      return;
    }
    if (verb === "chip") {
      if (controls.pick(+k)) e.preventDefault();
      return;
    }
    if (verb === "go") {
      if (control) {
        // (a mouse-focused control: Space is the table's - the browser never presses that control on the key's release)
        e.preventDefault();
        spaceEaten = true;
        controls.run("go");
      } else if (boardSeen && controls.can("go")) {
        e.preventDefault();
        controls.run("go");
      }
      return;
    }
    if (controls.run(verb)) e.preventDefault();
  });
  doc.addEventListener("keyup", function (e) {
    if (spaceEaten && String(e.key || "") === " ") {
      spaceEaten = false;
      e.preventDefault();
    }
  });

  $("cz-histbtn").onclick = function () {
    CZ.openSheet("cz-histsheet");
    CZ.loadHistory(function (r) {
      var pocket = r.results && r.results.number;
      // 1.99aoh: the pocket as the strip shows it (the same .rl-pocket colours + spoken word), then the spin's number
      var chip =
        Number.isInteger(pocket) && pocket >= 0 && pocket <= 36
          ? '<span class="rl-pocket ' +
            R.pocketColor(pocket) +
            '" role="img" aria-label="' +
            CZ.esc(R.pocketLabel(pocket)) +
            '" title="' +
            CZ.esc(R.pocketLabel(pocket)) +
            '">' +
            pocket +
            "</span> "
          : "";
      return (
        '<div class="hh"><b>' +
        chip +
        CZ.esc(T("rl_spin_number", "Spin {n}", { n: r.round })) +
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
        var a = doc.createElement("a");
        a.href = "/casino/roulette/t/" + w.id;
        a.textContent = (w.high_stakes ? "💎 " : "") + (w.room_name || (w.lobby ? T("rl_lobby", "Lobby wheel") : T("rl_web_wheel", "Web wheel")));
        $("rl-wheels").append(a);
      });
      var nav = $("rl-wheels");
      if (nav) nav.hidden = !nav.querySelector("a");
    })
    .catch(function () {});
})(window);
