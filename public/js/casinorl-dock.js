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
  function receipt(bets) {
    return bets
      .map(function (b) {
        return b.token + " " + b.amount.toLocaleString();
      })
      .join(" · ");
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
  function controls(box, opts) {
    var chip = 100,
      snapshot = null,
      pending = [],
      flight = [],
      timer,
      stopped = false,
      busy = false,
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
        return l.text;
      });
      if (me && me.pending) texts.push(T("rl_queued", "Next spin: {line}", { line: me.pending }));
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
    function flush() {
      if (busy || stopped || !pending.length) return;
      flight = pending.splice(0, 20);
      void send("bet", { bets: flight });
    }
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(flush, 300);
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
      schedule();
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
      time.textContent = end ? secs + "s" : phase(t);
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
        snapshot = d;
        clock = d.now ? Date.now() - Number(d.now) : 0;
        updateControls();
        countdown();
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
      widget,
      latest = 0;
    var state = element("p", "rl-state", T("rl_loading", "Loading wheel…")),
      recent = element("p", "rl-recent"),
      field = element("div", "rl-quick");
    var open = element("a", "rl-table-link", T("rl_full_table", "Open full table"));
    var account = element("div");
    open.hidden = true;
    box.append(state, recent, field, open, account);
    if (opts.linked) box.append(element("p", "", T("rl_type_hint", "You can also type !rl red 500 in this chat.")));
    function leaveWheel() {
      if (widget) widget.close();
      widget = null;
      id = null;
      field.replaceChildren();
      account.replaceChildren();
      recent.textContent = "";
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
        if (id && id !== where.table) leaveWheel();
        var resp = await fetch("/api/casino/t/" + where.table, { credentials: "same-origin", cache: "no-store" });
        var d = await resp.json();
        if (shut || generation !== latest) return;
        if (!d.ok || d.table.status !== "open") {
          leaveWheel();
          state.textContent = d.error || T("closed", "That table has closed.");
          return;
        }
        if (!widget) {
          id = where.table;
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
          (where.here ? T("rl_room_wheel", "Room wheel") : T("rl_lobby", "Lobby wheel")) + " · " + phase(d.table);
        recent.textContent = d.table.history
          .slice(-5)
          .map(function (r) {
            return outcome(r.number);
          })
          .join(" · ");
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
  W.PATVRoulette = { mount: mount, controls: controls, phase: phase, outcome: outcome, outside: outside };
})(window);
