/* Roulette slip controls shared by the table and the Room Dock. */
(function (W) {
  "use strict";
  var grammar = W.PATVRlBets;
  var T = function (k, d, v) {
    return W.__t
      ? W.__t("js.casino." + k, d, v)
      : d.replace(/\{(\w+)\}/g, function (_, n) {
          return v[n];
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
  function receipt(bets) {
    return bets
      .map(function (b) {
        return (feltName[b.token] || b.token) + " " + b.amount.toLocaleString();
      })
      .join(" · ");
  }
  function shown(text) {
    var bets = String(text || "")
      .split(" · ")
      .flatMap(function (position) {
        var parsed = grammar.parse(position, { maxPairs: 20, minBet: 1 });
        return parsed.ok ? parsed.bets : [];
      });
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
  // roulette2 O8: one pocket as the felt colours it - .rl-pocket.red / .black / .zero (public/css/casinorl-dock.css, loaded by the
  // table page and the pad page). The colour comes from the client's red list (PATVRlBets.red), never a server field (rlengine
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
  function controls(box, opts) {
    var chip = 100,
      snapshot = null,
      pending = [],
      flight = [],
      timer,
      stopped = false,
      busy = false,
      lastNote = null,
      clock = 0;
    var root = element("div", "rl-controls"),
      chipRow = element("div", "rl-chips"),
      actionRow = element("div", "rl-actions");
    var time = element("span", "rl-timer"),
      feedback = element("output", "rl-feedback"),
      mine = element("p", "rl-own");
    var amount = element("input"),
      input = element("input"),
      preview = element("output", "rl-preview");
    var form = element("form", "rl-slip"),
      textLabel = element("label", "", T("rl_bet_line", "Bet line"));
    var add = element("button", "", T("rl_place_line", "Place line"));
    add.type = "submit";
    amount.type = "text";
    amount.inputMode = "decimal";
    amount.maxLength = 14;
    amount.placeholder = T("rl_custom", "Custom");
    amount.setAttribute("aria-label", T("rl_custom_chip", "Custom chip in PAT"));
    input.maxLength = 160;
    input.placeholder = "red 500 · 17 100".replace(" · ", " ");
    input.autocomplete = "off";
    feedback.setAttribute("role", "status");
    textLabel.append(input);
    chipRow.setAttribute("aria-label", T("rl_chip_value", "Chip value"));
    [100, 500, 1000, 5000, 25000].forEach(function (v) {
      var b = button(
        v >= 1000 ? v / 1000 + "K" : String(v),
        function () {
          chip = v;
          amount.value = "";
          mark();
        },
        "rl-chip",
      );
      b.dataset.chip = v;
      chipRow.append(b);
    });
    function mark() {
      Array.from(chipRow.querySelectorAll("[data-chip]")).forEach(function (b) {
        b.setAttribute("aria-pressed", String(+b.dataset.chip === chip));
      });
    }
    amount.addEventListener("input", function () {
      chip = W.PATVAmount.parse(amount.value);
      mark();
    });
    mark();
    chipRow.append(amount);
    actionRow.append(time);
    var actions = {};
    function action(verb, label) {
      var b = button(label, function () {
        if (!busy && !pending.length && !flight.length) void send(verb, {});
      });
      actions[verb] = b;
      actionRow.append(b);
    }
    action("undo", T("rl_undo", "Undo"));
    action("clear", T("clear", "Clear"));
    action("rebet", T("rl_rebet", "Rebet"));
    if (!opts.compact) action("go", T("rl_spin_now", "Spin now"));
    function minimum() {
      return (snapshot && snapshot.table.limits && snapshot.table.limits.rl_min_bet) || 100;
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
      if (parse().ok && !busy && eligible() && !pending.length) void send("bet", { line: input.value });
    });
    form.append(textLabel, add, preview);
    root.append(chipRow, actionRow, form, mine, feedback);
    box.append(root);
    function eligible() {
      return !!(snapshot && snapshot.me && !snapshot.me.banned && snapshot.table.status === "open");
    }
    function available() {
      return eligible() && !stopped;
    }
    function updateControls() {
      var me = snapshot && snapshot.me,
        t = snapshot && snapshot.table,
        waiting = busy || !!pending.length || !eligible();
      actions.undo.disabled = waiting || !me.lines.length || t.phase !== "betting";
      actions.clear.disabled = waiting || !(me.pending || (t.phase === "betting" && me.lines.length));
      actions.rebet.disabled = waiting || !me.last_slip;
      if (actions.go)
        actions.go.hidden = !(eligible() && t.phase === "betting" && t.totals.players === 1 && me.staked > 0);
      if (actions.go) actions.go.disabled = waiting;
      chipRow.querySelectorAll("button,input").forEach(function (b) {
        b.disabled = !eligible();
      });
      input.disabled = !eligible();
      previewLine();
      var texts = ((me && me.lines) || []).map(function (l) {
        return shown(l.text);
      });
      if (me && me.pending) texts.push(T("rl_queued", "Next spin: {line}", { line: shown(me.pending) }));
      // UI-2: the Dock sheet has no felt or net line of its own - its result says the player's own net here
      if (opts.compact && me && t.phase === "result" && typeof me.net === "number")
        texts.unshift(T("rl_net", "Your net {n} PAT", { n: (me.net > 0 ? "+" : "") + me.net.toLocaleString() }));
      mine.textContent = texts.length ? texts.join("  /  ") : "";
      if (opts.paint) opts.paint(accountLines(me), pending.concat(flight));
    }
    async function send(verb, body) {
      if (!available() || busy) return;
      busy = true;
      updateControls();
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
        var j = await response.json();
        if (stopped) return;
        feedback.textContent = j.reply || j.error || (j.ok ? "" : T("act_fail", "That didn't work."));
        if (j.ok && body.line) input.value = "";
      } catch (_) {
        if (!stopped)
          feedback.textContent = T("rl_connection", "Connection lost. Check your bets before placing another line.");
      } finally {
        if (!stopped) {
          try {
            await opts.refresh();
          } finally {
            flight = [];
            busy = false;
            updateControls();
            if (pending.length) schedule();
          }
        }
      }
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
      void send("bet", { bets: queued.concat(flight) });
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
      if (!available()) return;
      if (!Number.isSafeInteger(chip) || chip < minimum()) {
        feedback.textContent = T("rl_chip_min", "Choose a chip of at least {n} PAT.", { n: minimum() });
        return;
      }
      if (pending.length >= 20) {
        feedback.textContent = T("rl_batch_wait", "Wait for this line to finish.");
        return;
      }
      pending.push({ b: token, a: String(chip) });
      updateControls();
      if (pending.length >= 20) {
        clearTimeout(timer);
        flush();
      } else schedule();
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
      var span =
        t.phase === "betting"
          ? t.limits.rl_bet_secs
          : t.phase === "spinning"
            ? t.limits.rl_spin_secs
            : t.limits.rl_result_secs;
      time.style.setProperty("--left", String(Math.min(1, secs / (span || 1))));
    }
    var ticker = setInterval(countdown, 250);
    return {
      place: place,
      undoPosition: undoPosition,
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
      },
    };
  }
  function mount(box, opts) {
    var shut = false,
      timer,
      id,
      idHere = false,
      widget,
      latest = 0;
    var state = element("p", "rl-state", T("rl_loading", "Loading wheel…")),
      recent = element("p", "rl-recent"),
      field = element("div", "rl-quick"),
      intro = element("p", "rl-intro"),
      asked = false;
    var open = element("a", "rl-table-link", T("rl_full_table", "Open full table"));
    var account = element("div");
    open.hidden = true;
    intro.hidden = true;
    box.append(state, intro, recent, field, open, account);
    if (opts.linked) box.append(element("p", "", T("rl_type_hint", "You can also type !rl red 500 in this chat.")));
    function leaveWheel() {
      if (widget) widget.close();
      widget = null;
      id = null;
      field.replaceChildren();
      account.replaceChildren();
      recent.textContent = "";
      recent.dataset.round = "";
      open.hidden = true;
      open.removeAttribute("href");
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
        }
        state.textContent =
          ((target === where.table ? where.here : idHere) ? T("rl_room_wheel", "Room wheel") : T("rl_lobby", "Lobby wheel")) + " · " + phase(d.table);
        // roulette2 O8: the last five pockets in the felt's colours, newest first (and larger) like the table's history strip
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
  };
})(window);
