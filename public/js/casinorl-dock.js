/* Roulette slip controls shared by the table and the Room Dock.
   roulette2 WP5b (O7 / O9 / O13, contract 9): the chip rack is the casino's own chips (public/css/casino-chips.css .chipbtn / .chip,
   the regular and the 💎 denominations, filtered by the wheel's largest position cap), the actions are the table's .cz-btn buttons
   (Undo, Clear, Rebet, ×2, Spin now), the typed bet line folds into "Type a bet", a meter says what is on the layout and what is left
   this spin, and every chip is checked against the wheel's limits (t.rules - the same lim(T) the server checks) before it is queued,
   with the reason shown at once. The server checks everything again. Call bets and ×2 go as ONE ordinary line (placeMany). The Room
   Dock (pad-dock.js mount -> mount() below) keeps its compact sheet, now with a mini wheel (casino/rlwheel.js, loaded when the sheet
   opens) and the layout's players line. Every POST carries its own idempotency key. */
(function (W) {
  "use strict";
  var grammar = W.PATVRlBets;
  var T = function (k, d, v) {
    if (W.__t) return W.__t("js.casino." + k, d, v);
    // (a plural default {"one": ..., "other": ...} picks by vars.count, as the site's i18n does for English)
    if (d && typeof d === "object") d = v && v.count === 1 ? d.one : d.other;
    return String(d).replace(/\{(\w+)\}/g, function (m, n) {
      return v && v[n] != null ? v[n] : m;
    });
  };
  function element(tag, cls, label) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (label !== undefined) el.textContent = label;
    return el;
  }
  function button(label, run, cls) {
    var b = element("button", cls, label);
    b.type = "button";
    b.addEventListener("click", run);
    return b;
  }
  function fmt(n) {
    try {
      return Math.trunc(Number(n) || 0).toLocaleString();
    } catch (_) {
      return String(Math.trunc(Number(n) || 0));
    }
  }
  /** the chip labels: 500, 1K, 25K, 1M (casino-ui.js CZ.short) */
  function short(n) {
    return n >= 1e6 ? +(n / 1e6).toFixed(1) + "M" : n >= 1e3 ? +(n / 1e3).toFixed(1) + "K" : String(n);
  }
  function accountLines(me) {
    return ((me && me.lines) || []).map(function (line) {
      // One paid Rebet can span several original submissions. Decode its recorded positions individually.
      return line.text.split(" · ").flatMap(function (position) {
        var parsed = grammar.parse(position, {maxPairs:20, minBet:1});
        return parsed.ok ? parsed.bets : [];
      });
    });
  }
  // UI-11: a slip reads in the felt's words (1–12, Column 2, 1–18), not the grammar's tokens (d1, c2, low)
  // (WP5b: an inside position by its numbers with en dashes - 0–2–3, 25–26–28–29)
  function receipt(bets) {
    return bets
      .map(function (b) {
        var p = grammar.positions[b.token];
        return (feltName[b.token] || (p && p.nums.length > 1 && /\d-\d/.test(b.token) ? p.nums.join("–") : b.token)) + " " + b.amount.toLocaleString();
      })
      .join(" · ");
  }
  function parseSlip(text) {
    return String(text || "")
      .split(" · ")
      .flatMap(function (position) {
        var parsed = grammar.parse(position, { maxPairs: 20, minBet: 1 });
        return parsed.ok ? parsed.bets : [];
      });
  }
  function shown(text) {
    var bets = parseSlip(text);
    return bets.length ? receipt(bets) : text;
  }
  function phase(t) {
    if (t.phase === "idle" || t.phase === "betting") return T("rl_open", "Bets open");
    if (t.phase === "spinning") return T("rl_spinning", "No more bets");
    if (t.phase === "closed") return T("closed", "That table has closed.");
    return T("rl_result", "Result");
  }
  function outcome(n) {
    if (n === 0) return T("rl_zero", "0 · Zero");
    return grammar.red.indexOf(n) >= 0
      ? T("rl_red_word", "{n} ◆ Red", { n: n })
      : T("rl_black_word", "{n} ● Black", { n: n });
  }
  // 1.99aoh: one pocket as the felt colours it - .rl-pocket.red / .black / .zero (contract 9: public/css/casino-chips.css, loaded
  // by the table page and the pad page). The colour comes from the client's red list (PATVRlBets.red), never a server field (rlengine
  // says "green" for 0). The number is the text, the felt's ◆ / ● glyph is drawn by the CSS, and the colour is also a word for
  // screen readers ("Spin 41: 14 red"). The table's history strip, its history sheet and the Room Dock's recent line all use it.
  function pocketColor(n) {
    return n === 0 ? "zero" : grammar.red.indexOf(n) >= 0 ? "red" : "black";
  }
  function pocketLabel(n, round) {
    var c = pocketColor(n),
      w =
        c === "zero"
          ? T("rl_pocket_zero", "{n} green", { n: n })
          : c === "red"
            ? T("rl_pocket_red", "{n} red", { n: n })
            : T("rl_pocket_black", "{n} black", { n: n });
    return round ? T("rl_pocket_spin", "Spin {round}: {pocket}", { round: round, pocket: w }) : w;
  }
  function pocket(n, round, newest) {
    var el = element("span", "rl-pocket " + pocketColor(n) + (newest ? " newest" : ""), String(n)),
      label = pocketLabel(n, round);
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", label);
    el.setAttribute("title", label);
    return el;
  }
  var outside = [
    ["low", "1–18"],
    ["even", T("rl_even", "Even")],
    ["red", T("rl_red", "◆ Red")],
    ["black", T("rl_black", "● Black")],
    ["odd", T("rl_odd", "Odd")],
    ["high", "19–36"],
    ["d1", "1–12"],
    ["d2", "13–24"],
    ["d3", "25–36"],
    ["c1", T("rl_col", "Column {n}", { n: 1 })],
    ["c2", T("rl_col", "Column {n}", { n: 2 })],
    ["c3", T("rl_col", "Column {n}", { n: 3 })],
  ];
  // (the coded tokens only - red / black / even / odd read as they are)
  var feltName = {};
  outside.forEach(function (p) {
    if (/^(?:[dc][123]|low|high)$/.test(p[0])) feltName[p[0]] = p[1];
  });
  // roulette2 O7: the wheel's limits as the server checks them - t.rules (casino/roulette.js rules(T) = lim(T), the spin's own
  // snapshot, D3), or for an older server the rl_* map in t.limits. caps: straight / split / street / corner / line / outside;
  // kinds maps trio -> street, first_four -> corner and every outside kind -> outside.
  var KINDS = {
    trio: "street",
    first_four: "corner",
    dozen: "outside",
    column: "outside",
    red: "outside",
    black: "outside",
    even: "outside",
    odd: "outside",
    low: "outside",
    high: "outside",
  };
  function rulesOf(t) {
    var r = t && t.rules,
      L = (t && t.limits) || {};
    if (r && r.caps && r.min) return { min: r.min, caps: r.caps, kinds: r.kinds || KINDS, max_spin: r.max_spin, max_positions: r.max_positions, max_actions: r.max_actions, bet_secs: r.bet_secs, spin_secs: r.spin_secs, result_secs: r.result_secs };
    return {
      min: L.rl_min_bet || 100,
      caps: { straight: L.rl_max_straight, split: L.rl_max_split, street: L.rl_max_street, corner: L.rl_max_corner, line: L.rl_max_line, outside: L.rl_max_outside },
      kinds: KINDS,
      max_spin: L.rl_max_spin,
      max_positions: L.rl_max_positions,
      max_actions: L.rl_max_lines,
      bet_secs: L.rl_bet_secs,
      spin_secs: L.rl_spin_secs,
      result_secs: L.rl_result_secs,
    };
  }
  /** a position's cap per player this spin (the server's capFor) */
  function capOf(t, token) {
    var p = grammar.positions[token],
      R = rulesOf(t);
    if (!p) return 0;
    var k = R.kinds[p.kind] || (R.caps[p.kind] != null ? p.kind : "outside");
    return R.caps[k] || R.caps.outside || 0;
  }
  // contract 9: the regular chips (100 ... 25K) and the 💎 ones (100K ... 5M, High Rollers and High Roller wheels), up to the wheel's
  // largest position cap (no chip that can't go anywhere) and from its minimum (a High Roller wheel starts at 1,000)
  var REG = [[100, ""], [500, "c500"], [1000, "c1k"], [5000, "c5k"], [25000, "c25k"]],
    HRC = [[100000, "c100k hrc"], [500000, "c500k hrc"], [1000000, "c1m hrc"], [5000000, "c5m hrc"]];
  function rackFor(t, me) {
    var R = rulesOf(t),
      hr = !!((t && t.high_stakes) || (me && me.high_roller)),
      top = Math.max.apply(
        null,
        Object.keys(R.caps || {}).map(function (k) {
          return Number(R.caps[k]) || 0;
        }).concat([0]),
      );
    if (!top) top = 25000;
    var set = REG.concat(hr ? HRC : []).filter(function (c) {
      return c[0] >= R.min && c[0] <= top && (!R.max_spin || c[0] <= R.max_spin);
    });
    if (!set.length) set = [[R.min, ""]];
    return set.slice(-6);
  }
  function controls(box, opts) {
    var chip = 100,
      custom = false,
      snapshot = null,
      pending = [],
      flight = [],
      flightTotal = 0,
      after = [],
      timer,
      stopped = false,
      busy = false,
      lastNote = null,
      hovered = null,
      clock = 0;
    var compact = !!opts.compact,
      keyed = !compact && opts.keys !== false;
    var root = element("div", "rl-controls" + (compact ? " rl-compact" : "")),
      chipRow = element("div", "rl-chips"),
      rack = element("div", "rl-rack"),
      actionRow = element("div", "rl-actions");
    var time = element("span", "rl-timer"),
      feedback = element("output", "rl-feedback"),
      meter = element("p", "rl-meter"),
      mine = element("p", "rl-own");
    var amount = element("input"),
      input = element("input"),
      preview = element("output", "rl-preview");
    var form = element("form", "rl-slip"),
      foot = element("div", "rl-foot"),
      custom1 = element("label", "rl-custom", T("rl_custom_chip", "Custom chip in PAT")),
      typed = element("details", "rl-type"),
      typedSum = element("summary", "", T("rl_type_bet", "Type a bet")),
      textLabel = element("label", "", T("rl_bet_line", "Bet line"));
    var add = element("button", compact ? "" : "cz-btn gold sm", T("rl_place_line", "Place line"));
    add.type = "submit";
    amount.type = "text";
    amount.inputMode = "decimal";
    amount.maxLength = 14;
    amount.placeholder = T("rl_custom", "Custom");
    amount.className = "rl-amount";
    input.maxLength = 160;
    input.placeholder = "red 500 · 17 100".replace(" · ", " ");
    input.autocomplete = "off";
    feedback.setAttribute("role", "status");
    textLabel.append(input);
    chipRow.setAttribute("role", "group");
    chipRow.setAttribute("aria-label", T("rl_chip_value", "Chip value"));
    rack.dataset.v = "";
    var chips = [];
    function drawRack() {
      var t = snapshot && snapshot.table,
        set = t ? rackFor(t, snapshot.me) : REG,
        sig = set
          .map(function (c) {
            return c[0];
          })
          .join();
      if (rack.dataset.v === sig) return;
      rack.dataset.v = sig;
      rack.replaceChildren();
      chips = set.map(function (c, i) {
        var b = button(
          "",
          function () {
            chip = c[0];
            custom = false;
            amount.value = "";
            mark();
          },
          "chipbtn" + (/hrc/.test(c[1]) ? " hr" : ""),
        );
        var face = element("span", "chip" + (c[1] ? " " + c[1] : ""));
        face.setAttribute("aria-hidden", "true");
        b.append(face, element("span", "l", short(c[0])));
        b.dataset.chip = String(c[0]);
        b.setAttribute("aria-label", T("rl_chip_n", "Chip {n} PAT", { n: fmt(c[0]) }));
        // (contract 13 / O13(8): the 1-5 keys pick these chips on the table page)
        if (i < 5) b.dataset.key = String(i + 1);
        if (keyed && i < 5) b.setAttribute("aria-keyshortcuts", String(i + 1));
        rack.append(b);
        return b;
      });
      if (!custom && !set.some(function (c) {
        return c[0] === chip;
      }))
        chip = set[0][0];
      mark();
    }
    function mark() {
      chips.forEach(function (b) {
        b.setAttribute("aria-pressed", String(!custom && +b.dataset.chip === chip));
      });
    }
    amount.addEventListener("input", function () {
      chip = W.PATVAmount.parse(amount.value);
      custom = !!amount.value;
      mark();
    });
    // (the round timer ends the chip row; a custom chip and a typed line fold under "Type a bet" - a phone's sticky dock stays short)
    chipRow.append(rack, time);
    custom1.append(amount);
    var actions = {};
    function action(verb, label, cls, keys, run) {
      var b = button(
        label,
        run ||
          function () {
            if (!busy && !pending.length && !flight.length) void send(verb, {});
          },
        compact ? "" : cls,
      );
      if (!compact && keys) b.dataset.key = keys;
      if (keyed && keys) b.setAttribute("aria-keyshortcuts", keys);
      actions[verb] = b;
      actionRow.append(b);
    }
    action("undo", T("rl_undo", "Undo"), "cz-btn ghost sm", "Z");
    action("clear", T("clear", "Clear"), "cz-btn ghost sm", "C");
    action("rebet", T("rl_rebet", "Rebet"), "cz-btn ghost sm", "R", function () {
      var me = snapshot && snapshot.me;
      if (!busy && !pending.length && !flight.length) void send("rebet", {}, total(parseSlip(me && me.last_slip)));
    });
    action("double", T("rl_double", "×2"), "cz-btn ghost sm", "D", function () {
      double();
    });
    if (!compact) action("go", T("rl_spin_now", "Spin now"), "cz-btn gold sm", "Space");
    function minimum() {
      return (snapshot && rulesOf(snapshot.table).min) || 100;
    }
    function parse() {
      return grammar.parse(input.value, { minBet: minimum(), maxPairs: 20 });
    }
    function previewLine() {
      var p = parse();
      preview.textContent = !input.value ? "" : p.ok ? receipt(p.bets) : [p.error, p.hint].filter(Boolean).join(" ");
      add.disabled = !input.value || !p.ok || busy || pending.length > 0 || !eligible();
    }
    input.addEventListener("input", previewLine);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var p = parse();
      if (p.ok && !busy && eligible() && !pending.length) void send("bet", { line: input.value }, total(p.bets));
    });
    form.append(textLabel, add, preview);
    typed.append(typedSum, custom1, form);
    foot.append(meter, typed);
    root.append(chipRow, actionRow, foot, mine, feedback);
    box.append(root);
    function eligible() {
      var t = snapshot && snapshot.table,
        me = snapshot && snapshot.me;
      return !!(me && !me.banned && t.status === "open" && !(t.high_stakes && me.high_roller === false));
    }
    function available() {
      return eligible() && !stopped;
    }
    function betting() {
      var t = snapshot && snapshot.table;
      return !!t && (t.phase === "betting" || t.phase === "idle");
    }
    function total(bets) {
      return bets.reduce(function (s, b) {
        return s + (Number(b.amount != null ? b.amount : b.a) || 0);
      }, 0);
    }
    // what this player has on each position for the line a new chip joins: the spin's charged lines while bets are open
    // (me.used.per_token, or the lines themselves from an older server), the queued line while the wheel spins - plus the chips
    // waiting in the batch / in flight
    function have() {
      var me = snapshot && snapshot.me,
        out = {};
      if (!me) return out;
      if (betting()) {
        if (me.used && me.used.per_token) Object.keys(me.used.per_token).forEach(function (k) {
          out[k] = me.used.per_token[k];
        });
        else accountLines(me).forEach(function (bs) {
          bs.forEach(function (b) {
            out[b.token] = (out[b.token] || 0) + b.amount;
          });
        });
      } else if (me.pending)
        parseSlip(me.pending).forEach(function (b) {
          out[b.token] = (out[b.token] || 0) + b.amount;
        });
      pending.concat(flight).forEach(function (b) {
        out[b.b] = (out[b.b] || 0) + Number(b.a);
      });
      return out;
    }
    function spent(h) {
      return Object.keys(h).reduce(function (s, k) {
        return s + h[k];
      }, 0);
    }
    /** the reason a set of {b, a} pairs can't join the player's bets now (the server's lineLimits, advisory), or "" */
    function refusal(pairs) {
      var t = snapshot.table,
        R = rulesOf(t),
        h = have(),
        n;
      for (var i = 0; i < pairs.length; i++) {
        var b = pairs[i],
          a = Number(b.a),
          cap = capOf(t, b.b);
        if (!Number.isSafeInteger(a) || a < R.min) return T("rl_chip_min", "Choose a chip of at least {n} PAT.", { n: fmt(R.min) });
        if (cap && (h[b.b] || 0) + a > cap)
          return T("rl_cap_over", "{spot}: the most per player is {cap} PAT a spin — you have {have} PAT there.", {
            spot: spotName(b.b),
            cap: fmt(cap),
            have: fmt(h[b.b] || 0),
          });
        h[b.b] = (h[b.b] || 0) + a;
      }
      if (R.max_positions && (n = Object.keys(h).length) > R.max_positions)
        return T("rl_pos_over", "Up to {max} spots a spin per player.", { max: fmt(R.max_positions) });
      if (R.max_spin && spent(h) > R.max_spin)
        return T("rl_spin_over", "Your total this spin would be {total} PAT — the most per player per spin is {max} PAT.", {
          total: fmt(spent(h)),
          max: fmt(R.max_spin),
        });
      return "";
    }
    // O7: a refusal's code and numbers (casino/roulette.js no()) in the felt's words; the server's own text otherwise
    function said(j, lineTotal) {
      if (!j || j.ok) return (j && j.reply) || "";
      if (j.code === "E_SPIN" && j.max && typeof lineTotal === "number")
        return T("rl_spin_over", "Your total this spin would be {total} PAT — the most per player per spin is {max} PAT.", {
          total: fmt((Number(j.have) || 0) + (lineTotal || 0)),
          max: fmt(j.max),
        });
      if (j.code === "E_CAP" && j.token && j.cap)
        return T("rl_cap_over", "{spot}: the most per player is {cap} PAT a spin — you have {have} PAT there.", {
          spot: spotName(j.token),
          cap: fmt(j.cap),
          have: fmt(j.have || 0),
        });
      if (j.code === "E_POS" && j.max) return T("rl_pos_over", "Up to {max} spots a spin per player.", { max: fmt(j.max) });
      if (j.code === "E_ACT" && j.max)
        return T("rl_act_over", "You've used all {max} bet actions this spin (each line, Undo and Clear counts).", { max: fmt(j.max) });
      if (j.code === "E_BANK" && j.token && grammar.positions[j.token])
        return j.more > 0
          ? T("rl_bank_more", "The wheel can take at most {n} PAT more on {spot} this spin.", { n: fmt(j.more), spot: spotName(j.token) })
          : T("rl_bank_none", "The wheel can't take more on {spot} this spin.", { spot: spotName(j.token) });
      return j.reply || j.error || T("act_fail", "That didn't work.");
    }
    function updateControls() {
      var me = snapshot && snapshot.me,
        t = snapshot && snapshot.table,
        waiting = busy || !!pending.length || !eligible();
      drawRack();
      actions.undo.disabled = waiting || !me.lines.length || t.phase !== "betting";
      actions.clear.disabled = waiting || !(me.pending || (t.phase === "betting" && me.lines.length));
      actions.rebet.disabled = waiting || !me.last_slip;
      actions.double.disabled = waiting || !(me.last_slip || (betting() && me.lines.length));
      actions.double.title =
        betting() && me && me.lines.length
          ? T("rl_double_label", "Double: the same bets again")
          : T("rl_double_last", "Your last spin's bets, doubled");
      if (actions.go)
        actions.go.hidden = !(eligible() && t.phase === "betting" && t.totals.players === 1 && me.staked > 0);
      if (actions.go) actions.go.disabled = waiting;
      var h = me ? have() : {},
        R = t ? rulesOf(t) : null,
        left = R && R.max_spin ? R.max_spin - spent(h) : Infinity,
        spotLeft = hovered && t ? capOf(t, hovered) - (h[hovered] || 0) : Infinity;
      chips.forEach(function (b) {
        var v = +b.dataset.chip;
        b.disabled = !eligible() || (me && v > left && left >= 0 && betting());
        b.classList.toggle("over", v > spotLeft);
      });
      amount.disabled = !eligible();
      input.disabled = !eligible();
      previewLine();
      // O7: what is on the layout and what is left this spin (bets open); while it spins, the line queued for the next one
      var on = me && me.staked ? me.staked : 0;
      meter.textContent =
        eligible() && betting() && R && R.max_spin
          ? T("rl_meter", "On the layout {staked} PAT · {left} PAT left this spin", {
              staked: fmt(on + pendingTotal()),
              left: fmt(Math.max(0, R.max_spin - on - pendingTotal())),
            })
          : "";
      var texts = ((me && me.lines) || []).map(function (l) {
        return shown(l.text);
      });
      if (me && me.pending) texts.push(T("rl_queued", "Next spin: {line}", { line: shown(me.pending) }));
      // UI-2: the Dock sheet has no felt or net line of its own - its result says the player's own net here
      if (compact && me && t.phase === "result" && typeof me.net === "number")
        texts.unshift(T("rl_net", "Your net {n} PAT", { n: (me.net > 0 ? "+" : "") + me.net.toLocaleString() }));
      mine.textContent = texts.length ? texts.join("  /  ") : "";
      if (opts.paint) opts.paint(accountLines(me), pending.concat(flight));
    }
    function pendingTotal() {
      return pending.concat(flight).reduce(function (s, b) {
        return s + Number(b.a);
      }, 0);
    }
    async function send(verb, body, lineTotal) {
      if (!available() || busy) return;
      busy = true;
      updateControls();
      var j = null;
      try {
        var idem =
          W.crypto && W.crypto.randomUUID
            ? W.crypto.randomUUID()
            : Date.now() + "-" + Math.random().toString(36).slice(2);
        var response = await fetch("/api/casino/t/" + opts.id + "/act", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
          body: JSON.stringify(Object.assign({ verb: verb, idem: idem }, body)),
        });
        j = await response.json();
        if (stopped) return;
        feedback.textContent = j.ok ? j.reply || "" : said(j, lineTotal);
        if (j.ok && body.line) input.value = "";
        if (opts.onSent) opts.onSent(verb, j);
      } catch (_) {
        if (!stopped)
          feedback.textContent = T("rl_connection", "Connection lost. Check your bets before placing another line.");
      } finally {
        if (!stopped) {
          try {
            await opts.refresh();
          } finally {
            flight = [];
            flightTotal = 0;
            busy = false;
            updateControls();
            if (after.length) {
              var next = after.shift();
              void sendLine(next);
            } else if (pending.length) schedule();
          }
        }
      }
      return j;
    }
    // UI-5: one queued line per player, and a new one replaces it - while the wheel spins (or shows its result) the felt's
    // chips are added to the queued line and sent as one
    function queuedBets() {
      var me = snapshot && snapshot.me,
        t = snapshot && snapshot.table;
      if (!me || !me.pending || !t || (t.phase !== "spinning" && t.phase !== "result")) return [];
      return accountLines({ lines: [{ text: me.pending }] })[0].map(function (b) {
        return { b: b.token, a: String(b.amount) };
      });
    }
    function flush() {
      if (busy || stopped || !pending.length) return;
      var queued = queuedBets();
      if (queued.length >= 20) queued = [];
      flight = pending.splice(0, 20 - queued.length);
      flightTotal = total(flight);
      void send("bet", { bets: queued.concat(flight) }, total(queued.concat(flight)));
    }
    // a call bet / ×2 that had to wait for the line in flight: it goes as its own line next (never split across two)
    function sendLine(pairs) {
      var queued = available() ? queuedBets() : [];
      if (!available() || queued.length + pairs.length > 20) {
        if (available()) feedback.textContent = T("rl_line_full", "That's more than 20 spots for one line.");
        // (review: the chain goes on - the next waiting line, or the chips placed meanwhile - never stranded, dimmed, with the buttons off)
        if (after.length) return sendLine(after.shift());
        if (pending.length) schedule();
        updateControls();
        return;
      }
      flight = pairs;
      flightTotal = total(pairs);
      updateControls();
      void send("bet", { bets: queued.concat(pairs) }, total(queued.concat(pairs)));
    }
    // UI-4: chips placed in a burst go as one line (each line is one of the spin's actions, rl_max_lines): the batch waits
    // BATCH_MS after the last chip, 20 chips go at once, and a window about to close is never missed
    var BATCH_MS = 900;
    function schedule() {
      clearTimeout(timer);
      var t = snapshot && snapshot.table,
        left = t && t.phase === "betting" && t.deadline ? t.deadline - (Date.now() - clock) - 1500 : BATCH_MS;
      timer = setTimeout(flush, Math.max(0, Math.min(BATCH_MS, left)));
    }
    function place(token) {
      if (!available()) return false;
      if (!Number.isSafeInteger(chip) || chip < minimum()) {
        feedback.textContent = T("rl_chip_min", "Choose a chip of at least {n} PAT.", { n: fmt(minimum()) });
        return false;
      }
      if (pending.length >= 20) {
        feedback.textContent = T("rl_batch_wait", "Wait for this line to finish.");
        return false;
      }
      // O7: the reason at once (the cap on this spot, the spots, the spin's maximum) - the server checks again
      var why = refusal([{ b: token, a: String(chip) }]);
      if (why) {
        feedback.textContent = why;
        return false;
      }
      feedback.textContent = "";
      pending.push({ b: token, a: String(chip) });
      updateControls();
      if (pending.length >= 20) {
        clearTimeout(timer);
        flush();
      } else schedule();
      return true;
    }
    /** several positions as ONE ordinary line (a call bet, ×2): checked first, never split across lines */
    function placeMany(pairs) {
      if (!available() || !pairs.length) return false;
      var queued = queuedBets();
      if (pairs.length + queued.length > 20) {
        feedback.textContent = T("rl_line_full", "That's more than 20 spots for one line.");
        return false;
      }
      var why = refusal(pairs);
      if (why) {
        feedback.textContent = why;
        return false;
      }
      feedback.textContent = "";
      // a line in flight: this one goes next, on its own; chips waiting in the batch that would make it more than 20 spots: the
      // batch goes now as it is, then this line on its own
      if (busy || (pending.length && pending.length + pairs.length + queued.length > 20)) {
        after.push(pairs);
        if (!busy) {
          clearTimeout(timer);
          flush();
        }
        updateControls();
        return true;
      }
      pending = pending.concat(pairs);
      clearTimeout(timer);
      flush();
      return true;
    }
    // ×2 (O13(7)): while bets are open with chips on the layout, the same bets again; otherwise the last spin's slip doubled -
    // either way ONE ordinary line (the server's limits and refusals apply as to any line)
    function double() {
      var me = snapshot && snapshot.me;
      if (!me || busy || pending.length || flight.length) return false;
      var bets = [];
      if (betting() && me.lines.length) {
        var h = {};
        accountLines(me).forEach(function (bs) {
          bs.forEach(function (b) {
            h[b.token] = (h[b.token] || 0) + b.amount;
          });
        });
        if (me.used && me.used.per_token) h = me.used.per_token;
        bets = Object.keys(h).map(function (k) {
          return { b: k, a: String(h[k]) };
        });
      } else if (me.last_slip)
        bets = parseSlip(me.last_slip).map(function (b) {
          return { b: b.token, a: String(b.amount * 2) };
        });
      if (!bets.length) return false;
      return placeMany(bets);
    }
    function undoPosition(token) {
      var lines = accountLines(snapshot && snapshot.me),
        last = lines[lines.length - 1];
      if (last && last.length === 1 && last[0].token === token && !actions.undo.disabled) void send("undo", {});
      else feedback.textContent = T("rl_undo_hint", "Use Undo or Clear.");
    }
    function countdown() {
      if (!snapshot) return;
      var t = snapshot.table,
        R = rulesOf(t),
        end =
          t.phase === "betting"
            ? t.deadline
            : t.phase === "spinning"
              ? t.land_at
              : t.phase === "result"
                ? t.result_until
                : 0;
      var secs = Math.max(0, Math.ceil((end - (Date.now() - clock)) / 1000));
      // UI-13: an idle wheel has no deadline - a dash keeps the ring round (the phase word is on the page / in the sheet)
      time.textContent = end ? T("rl_secs", "{n}s", { n: secs }) : "–";
      time.classList.toggle("idle", !end);
      var span = t.phase === "betting" ? R.bet_secs : t.phase === "spinning" ? R.spin_secs : R.result_secs;
      time.style.setProperty("--left", String(Math.min(1, secs / (span || 1))));
    }
    var ticker = setInterval(countdown, 250);
    function click(verb) {
      var b = actions[verb];
      if (!b || b.hidden || b.disabled) return false;
      b.click();
      return true;
    }
    return {
      place: place,
      placeMany: placeMany,
      double: double,
      undoPosition: undoPosition,
      /** the chip value a tap places now */
      chip: function () {
        return chip;
      },
      /** O13(8): pick the rack's n-th chip (1-based) - false when there isn't one or the rack is off */
      pick: function (n) {
        var b = chips[n - 1];
        if (!b || b.disabled) return false;
        b.click();
        return true;
      },
      /** a keyboard shortcut presses the button it names (undo / clear / rebet / double / go), only while it is shown and enabled */
      run: click,
      /** whether run(verb) would press its button now */
      can: function (verb) {
        var b = actions[verb];
        return !!(b && !b.hidden && !b.disabled);
      },
      /** the table page's keyboard shortcuts on / off: their aria-keyshortcuts hints follow (WCAG 2.1.4) */
      keys: function (on) {
        keyed = !compact && !!on;
        chips.concat(Object.keys(actions).map(function (k) {
          return actions[k];
        })).forEach(function (b) {
          if (keyed && b.dataset.key) b.setAttribute("aria-keyshortcuts", b.dataset.key);
          else b.removeAttribute("aria-keyshortcuts");
        });
      },
      /** a spot under the pointer / focus: chips above what is left on it are dimmed */
      hover: function (token) {
        hovered = token && grammar.positions[token] ? token : null;
        if (snapshot) updateControls();
      },
      capOf: function (token) {
        return snapshot ? capOf(snapshot.table, token) : 0;
      },
      refusal: function (pairs) {
        return snapshot ? refusal(pairs) : "";
      },
      say: function (text) {
        feedback.textContent = text || "";
      },
      update: function (d) {
        if (
          snapshot &&
          (snapshot.table.round_no !== d.table.round_no ||
            (snapshot.table.phase !== d.table.phase && d.table.phase === "result"))
        )
          feedback.textContent = "";
        // UI-2 / SUITES-2: why a queued line wasn't placed (refused when betting opened, or dropped by a close)
        var note = (d.me && d.me.private_note) || null;
        if (note && note !== lastNote) feedback.textContent = note;
        lastNote = note;
        snapshot = d;
        clock = d.now ? Date.now() - Number(d.now) : 0;
        updateControls();
        countdown();
      },
      // SUITES-6: the player still has PAT on this wheel (a line, a queued line, or the result of their spin is up)
      riding: function () {
        var me = snapshot && snapshot.me,
          t = snapshot && snapshot.table;
        return !!(
          me &&
          t &&
          t.status === "open" &&
          (me.staked > 0 || me.pending || (t.phase === "result" && typeof me.net === "number"))
        );
      },
      close: function () {
        stopped = true;
        clearInterval(ticker);
        clearTimeout(timer);
        pending = [];
        after = [];
      },
    };
  }
  function spotName(token) {
    var p = grammar.positions[token];
    if (!p) return token;
    if (p.kind === "straight") return outcome(p.nums[0]);
    if (feltName[token]) return feltName[token];
    if (/^(?:red|black|even|odd)$/.test(token)) {
      for (var i = 0; i < outside.length; i++) if (outside[i][0] === token) return outside[i][1];
    }
    return p.nums.join("–");
  }
  // the Room Dock's mini wheel (O11: compact - no numbers, no streak): casino/rlwheel.js is loaded the first time a sheet opens
  // (the pad page doesn't carry it), once per page
  var wheelLoad = null;
  function wheelModule() {
    if (W.PATVRlWheel) return Promise.resolve(W.PATVRlWheel);
    if (wheelLoad) return wheelLoad;
    wheelLoad = new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = "/api/casino/rlwheel.js?v=2";
      s.async = true;
      s.onload = function () {
        resolve(W.PATVRlWheel || null);
      };
      s.onerror = function () {
        wheelLoad = null;
        resolve(null);
      };
      (document.head || document.body).append(s);
    });
    return wheelLoad;
  }
  function mount(box, opts) {
    var shut = false,
      timer,
      id,
      idHere = false,
      widget,
      wheel = null,
      lastD = null,
      latest = 0;
    var state = element("p", "rl-state", T("rl_loading", "Loading wheel…")),
      top = element("div", "rl-dtop"),
      mini = element("canvas", "rl-mini"),
      side = element("div", "rl-dside"),
      who = element("p", "rl-who"),
      recent = element("p", "rl-recent"),
      field = element("div", "rl-quick"),
      intro = element("p", "rl-intro"),
      asked = false;
    var open = element("a", "rl-table-link", T("rl_full_table", "Open full table"));
    var account = element("div");
    open.hidden = true;
    intro.hidden = true;
    mini.hidden = true;
    mini.setAttribute("width", "112");
    mini.setAttribute("height", "112");
    side.append(state, who, recent);
    top.append(mini, side);
    box.append(top, intro, field, open, account);
    if (opts.linked) box.append(element("p", "", T("rl_type_hint", "You can also type !rl red 500 in this chat.")));
    function paintWheel(d) {
      if (!wheel || !d) return;
      var t = d.table;
      wheel.setSkew(d.now ? Date.now() - Number(d.now) : 0);
      if (t.phase === "spinning" && t.spin) wheel.spin(t);
      else if (t.phase === "result" && t.last_round && typeof t.last_round.number === "number") wheel.rest(t.last_round.number);
      else wheel.idle();
    }
    function leaveWheel() {
      if (widget) widget.close();
      widget = null;
      id = null;
      field.replaceChildren();
      account.replaceChildren();
      recent.textContent = "";
      recent.dataset.round = "";
      who.textContent = "";
      open.hidden = true;
      open.removeAttribute("href");
      if (wheel) wheel.destroy();
      wheel = null;
      mini.hidden = true;
    }
    async function refresh() {
      if (shut) return;
      var generation = ++latest;
      try {
        var where = await (
          await fetch("/api/casino/roulette/pad/" + encodeURIComponent(opts.slug), {
            credentials: "same-origin",
            cache: "no-store",
          })
        ).json();
        if (shut || generation !== latest) return;
        if (!where.ok || !/^[a-f0-9]{10}$/.test(where.table)) {
          leaveWheel();
          state.textContent = where.error || T("rl_off", "Roulette isn't open yet.");
          return;
        }
        // SUITES-6: while the member's line rides on this wheel (or its result is up) the sheet stays on it - a room wheel
        // opening in the pad's room takes over after that
        var target = id && id !== where.table && widget && widget.riding() ? id : where.table;
        if (id && id !== target) leaveWheel();
        // the first request of this sheet may take the one-time intro notice, which the sheet then shows (its polls never do)
        var ask = asked ? "" : "?notice=1";
        asked = true;
        var resp = await fetch("/api/casino/t/" + target + ask, { credentials: "same-origin", cache: "no-store" });
        var d = await resp.json();
        if (d.ok && d.me && d.me.notice && d.me.notice.id === "rl_intro") {
          intro.textContent = T(
            "rl_intro",
            "PAT are points with no cash value. Each spin is independent. The wheel has a single zero and straight up pays 35 to 1.",
          );
          intro.hidden = false;
        }
        if (shut || generation !== latest) return;
        if (!d.ok || d.table.status !== "open") {
          leaveWheel();
          state.textContent = d.error || T("closed", "That table has closed.");
          return;
        }
        if (!widget) {
          id = target;
          idHere = !!where.here;
          open.href = "/casino/roulette/t/" + id;
          open.hidden = false;
          widget = controls(account, { id: id, refresh: refresh, compact: true });
          outside.forEach(function (p) {
            field.append(
              button(p[1], function () {
                widget.place(p[0]);
              }),
            );
          });
          // O11: the compact mini wheel beside the sheet's state line (no wheel when the module can't load: the line stays)
          wheelModule().then(function (WH) {
            if (shut || !widget || id !== target || wheel || !WH || !WH.mount) return;
            mini.hidden = false;
            var quick = false;
            try {
              quick = !!W.localStorage && W.localStorage.getItem("rl-quick") === "1";
            } catch (_) {
              /* blocked storage: the system setting */
            }
            wheel = WH.mount(mini, { compact: true, palette: lastD && lastD.table.high_stakes ? "hr" : "classic", reduced: quick ? true : undefined });
            paintWheel(lastD);
          });
        }
        lastD = d;
        state.textContent =
          ((target === where.table ? where.here : idHere) ? T("rl_room_wheel", "Room wheel") : T("rl_lobby", "Lobby wheel")) + " · " + phase(d.table);
        // O10: the layout in a line - how many play and how much is on it, and the top three stakes (masked seats under their label)
        var seats = (d.table.seats || []).filter(function (s) {
          return s.staked > 0;
        });
        var top3 = seats
          .slice()
          .sort(function (a, b) {
            return b.staked - a.staked;
          })
          .slice(0, 3)
          .map(function (s) {
            return s.name + " " + short(s.staked);
          });
        // (D5: the seats' chips - while the result is up, the spin that landed; an older server: the table's totals)
        var players = d.table.felt ? seats.length : (d.table.totals && d.table.totals.players) || 0,
          pat = d.table.felt
            ? seats.reduce(function (a, s) {
                return a + s.staked;
              }, 0)
            : (d.table.totals && d.table.totals.staked) || 0;
        who.textContent = players
          ? T("rl_layout_n", { "one": "Layout: {players} player · {pat} PAT", "other": "Layout: {players} players · {pat} PAT" }, {
              players: players,
              pat: fmt(pat),
              count: players,
            }) + (top3.length ? " · " + top3.join(", ") : "")
          : "";
        // 1.99aoh: the last five pockets in the felt's colours, newest first (and larger) like the table's history strip
        var last5 = d.table.history.slice(-5).reverse(),
          shownKey = d.table.id + ":" + d.table.last_revealed + ":" + last5.length;
        if (recent.dataset.round !== shownKey) {
          recent.dataset.round = shownKey;
          recent.replaceChildren();
          if (last5.length) recent.append(element("span", "rl-recent-h", T("rl_recent", "Last spins")));
          last5.forEach(function (r, i) {
            recent.append(pocket(r.number, r.round_no, i === 0));
          });
        }
        widget.update(d);
        paintWheel(d);
      } catch (_) {
        if (!shut && generation === latest) state.textContent = T("net_fail", "Couldn't reach the table. Try again.");
      }
    }
    async function poll() {
      await refresh();
      if (!shut) timer = setTimeout(poll, document.hidden ? 5000 : 2000);
    }
    poll();
    return function () {
      shut = true;
      clearTimeout(timer);
      if (widget) widget.close();
      if (wheel) wheel.destroy();
      wheel = null;
    };
  }
  W.PATVRoulette = {
    mount: mount,
    controls: controls,
    phase: phase,
    outcome: outcome,
    outside: outside,
    pocket: pocket,
    pocketColor: pocketColor,
    pocketLabel: pocketLabel,
    // roulette2 WP5b: shared with the table page (casinorl.js)
    spotName: spotName,
    rulesOf: rulesOf,
    capOf: capOf,
    rackFor: rackFor,
    parseSlip: parseSlip,
    receipt: receipt,
  };
})(window);
