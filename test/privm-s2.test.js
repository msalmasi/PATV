// privacy controls S2 (G:/ops/privacy-controls-spec-2026-11-02.md section 5 "S2. One effective-privacy helper per repo"; section
// 1.2 = the owner's model, section 8 = his answers of 2026-11-02). A refactor: no behaviour changes.
//   * privacyeff.effOf = the owner's model, table-driven over EVERY combination of the stored switches (incognito, !bridge hide,
//     !transcripts off, !livecam off, and the future !chatrelay / !micrelay lists): each switch does one job; bridge off turns
//     every website switch on (the voice only once micrelay ships - BRIDGE_MUTES); never Pepe's memory
//   * quotes.isHidden split into isIncognito / isBridgeOff over EVERY state of the two sticky sets (hubhidden's set: none /
//     incognito / left out / loading x the archive's kind: none / anon / out / unreadable): the halves never overlap, isHidden is
//     exactly either, and every answer equals the S0 head's code (copied below, verbatim - the golden answers)
//   * privacyeff.raw / eff / stated on the real stores (chatlog_hidden reasons, chatlog_tx_hidden, incognito_state, livecam_optout)
//   node --test test/privm-s2.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-s2-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
const { runQuery } = require(path.join(repo, "dbUtils"));
const PE = require(path.join(repo, "privacyeff"));
const Q = require(path.join(repo, "quotes"));
const CL = require(path.join(repo, "chatlog"));
const HH = require(path.join(repo, "hubhidden"));
const LC = require(path.join(repo, "livecam"));
const INC = require(path.join(repo, "incognito"));

const hash = (l) => crypto.createHash("sha256").update("pepe-hidden:" + String(l).trim().toLowerCase()).digest("hex").slice(0, 20);
const OFF = (keys) => Object.fromEntries(keys.map((k) => [k, false]));

// ── 1. the model, table-driven ──
// The owner's table (spec 1.2), written out as rows {flag: the switches that turn it on} - not as the code computes it.
const TURNS_ON = {
  name: ["incognito", "bridge_off"],
  chat: ["chat_off", "bridge_off"],
  tx: ["tx_off", "bridge_off"],
  cam: ["livecam_off", "bridge_off"],
  voice: ["mic_off"],                 // bridge off mutes only once micrelay ships (S10)
  out: ["bridge_off"],
};

test("S2 model: the switches, the flags, bridge off doesn't mute yet - and the same names as Pepe's pepe_privacy.py", () => {
  assert.deepEqual([...PE.SWITCHES], ["incognito", "bridge_off", "tx_off", "livecam_off", "chat_off", "mic_off"]);
  assert.deepEqual([...PE.FLAGS], ["name", "chat", "tx", "cam", "voice", "out"]);
  assert.equal(PE.BRIDGE_MUTES, false);
  const bot = process.env.PEPE_BOT_DIR && path.join(process.env.PEPE_BOT_DIR, "pepe_privacy.py");
  if (bot && fs.existsSync(bot)) {                   // the twin agrees (run with PEPE_BOT_DIR = the bot repo)
    const src = fs.readFileSync(bot, "utf8");
    assert.ok(src.includes(`SWITCHES = (${PE.SWITCHES.map((s) => `"${s}"`).join(", ")})`), "pepe_privacy.SWITCHES matches");
    assert.ok(src.includes(`FLAGS = (${PE.FLAGS.map((s) => `"${s}"`).join(", ")})`), "pepe_privacy.FLAGS matches");
    assert.ok(/\nBRIDGE_MUTES = False\r?\n/.test(src), "pepe_privacy.BRIDGE_MUTES matches");
  }
});

test("S2 model: every combination of the six stored switches (64) follows the owner's table", () => {
  let n = 0;
  for (let bits = 0; bits < 1 << PE.SWITCHES.length; bits++) {
    const raw = Object.fromEntries(PE.SWITCHES.map((s, i) => [s, !!(bits & (1 << i))]));
    const got = PE.effOf(raw);
    const want = Object.fromEntries(PE.FLAGS.map((f) => [f, TURNS_ON[f].some((s) => raw[s])]));
    assert.deepEqual(got, want, JSON.stringify(raw));
    for (const v of Object.values(got)) assert.equal(typeof v, "boolean");
    // each switch does ONE job: turning one on (bridge off aside) moves only its own flag
    for (const s of PE.SWITCHES) {
      if (s === "bridge_off" || raw[s] || raw.bridge_off) continue;
      const after = PE.effOf({ ...raw, [s]: true });
      const moved = PE.FLAGS.filter((f) => after[f] !== got[f]);
      for (const f of moved) assert.ok(TURNS_ON[f].includes(s), `${s} moved ${f} from ${JSON.stringify(raw)}`);
    }
    // bridge off is an override: every website flag on, whatever the others say
    if (raw.bridge_off) for (const f of ["name", "chat", "tx", "cam", "out"]) assert.equal(got[f], true, `${f} under bridge off`);
    n++;
  }
  assert.equal(n, 64);
  assert.deepEqual(PE.effOf(null), OFF(PE.FLAGS));
  assert.deepEqual(PE.effOf({ remember_off: true }), OFF(PE.FLAGS), "Pepe's memory isn't a website switch");
  assert.deepEqual(PE.effOf({ incognito: "yes" }), OFF(PE.FLAGS), "only a real true / 1 counts");
});

// ── 2. quotes.isHidden's split, every state, against the S0 head's code ──
// d0446c58 quotes.js, verbatim (the golden answers), over its own inputs: hubhidden's loading, quotes' HIDDEN / LEFT, chatlog's kind
function baseAnswers(st, login) {
  const hubLoading = () => st.hubLoading;
  const stickyKindH = () => { if (st.kind === "throw") return "out"; return st.kind; };   // its catch -> "out"
  const HIDDEN = st.HIDDEN, LEFT = st.LEFT, hiddenHash = hash;
  const isHidden = (login) => {
    if (!login) return false;
    const h = hiddenHash(login);
    return hubLoading() || HIDDEN.has(h) || stickyKindH(h) != null;
  };
  const leftOutH = (h) => hubLoading() || LEFT.has(h) || stickyKindH(h) === "out";
  const isLeftOut = (login) => !!login && leftOutH(hiddenHash(login));
  return { isHidden: isHidden(login), isLeftOut: isLeftOut(login), isPrivate: isHidden(login) };
}

test("S2 quotes: isIncognito / isBridgeOff over every state of both sticky sets - never both, isHidden = either = the S0 head's answer", () => {
  const realLoading = HH.loading, realKind = CL.hiddenKind;
  const WHO = "Alice_CF";
  const h = hash(WHO);
  let n = 0;
  try {
    for (const hubLoading of [false, true]) {
      for (const hub of ["none", "incognito", "left", "left_unkinded"]) {
        for (const kind of [null, "anon", "out", "throw"]) {
          HH.loading = () => hubLoading;
          CL.hiddenKind = kind === "throw" ? () => { throw new Error("archive set unreadable"); } : () => kind;
          // hubhidden's handover: every hidden hash + the left-out ones (a list without leftOut = all left out, fail closed)
          if (hub === "none") Q.setHidden([]);
          else if (hub === "incognito") Q.setHidden([h], []);
          else if (hub === "left") Q.setHidden([h], [h]);
          else Q.setHidden([h]);
          const HIDDEN = new Set(hub === "none" ? [] : [h]);
          const LEFT = new Set(hub === "incognito" || hub === "none" ? [] : [h]);
          const st = { hubLoading, kind, HIDDEN, LEFT };
          for (const login of [WHO, WHO.toLowerCase(), " alice_cf ", "bob_cf", "", null]) {
            const label = JSON.stringify({ hubLoading, hub, kind, login });
            const want = baseAnswers(st, login);
            const inc = Q.isIncognito(login), off = Q.isBridgeOff(login);
            assert.equal(Q.isHidden(login), want.isHidden, "isHidden unchanged " + label);
            assert.equal(Q.isLeftOut(login), want.isLeftOut, "isLeftOut unchanged " + label);
            assert.equal(Q.isPrivate(login), want.isPrivate, "isPrivate unchanged " + label);
            assert.equal(Q.isHidden(login), inc || off, "isHidden = isIncognito || isBridgeOff " + label);
            assert.ok(!(inc && off), "never both " + label);
            assert.equal(off, Q.isLeftOut(login), "isBridgeOff = isLeftOut " + label);
            n++;
          }
        }
      }
    }
  } finally {
    HH.loading = realLoading;
    CL.hiddenKind = realKind;
    Q.setHidden([], []);
  }
  assert.equal(n, 2 * 4 * 4 * 6);
});

test("S2 quotes: the halves name the owner's two veils", () => {
  const realKind = CL.hiddenKind;
  try {
    CL.hiddenKind = (x) => (x === hash("incog_only") ? "anon" : x === hash("hide_only") ? "out" : null);
    Q.setHidden([], []);
    assert.deepEqual([Q.isIncognito("incog_only"), Q.isBridgeOff("incog_only")], [true, false], "incognito: the frog name, words shown");
    assert.deepEqual([Q.isIncognito("hide_only"), Q.isBridgeOff("hide_only")], [false, true], "!bridge hide: left out");
    assert.deepEqual([Q.isIncognito("nobody"), Q.isBridgeOff("nobody")], [false, false]);
    Q.setHidden([hash("hub_incog"), hash("hub_hide")], [hash("hub_hide")]);
    assert.deepEqual([Q.isIncognito("hub_incog"), Q.isBridgeOff("hub_incog")], [true, false], "hubhidden's set: outside LEFT = incognito");
    assert.deepEqual([Q.isIncognito("hub_hide"), Q.isBridgeOff("hub_hide")], [false, true], "hubhidden's set: LEFT = left out");
  } finally {
    CL.hiddenKind = realKind;
    Q.setHidden([], []);
  }
});

// ── 3. privacyeff on the real stores ──
const T0 = 1790000000000;
const setup = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER)`);
  await CL.init();
  await INC.init();
  await LC.init();
  const rows = {
    inc_only: { incognito: T0 }, hide_only: { bridge: T0 }, both: { bridge: T0, incognito: T0 }, forgot: { forget: T0 },
    unknown: { list_b: T0, list_i: T0 }, web_on: { web: T0 }, tx_hide: { bridge: T0 },
  };
  for (const [l, sc] of Object.entries(rows)) {
    await runQuery("INSERT INTO chatlog_hidden (h, since, src, scopes) VALUES (?, ?, 'pepe', ?)", [hash(l), T0, JSON.stringify(sc)]);
  }
  for (const l of ["tx_only", "tx_hide", "all4"]) await runQuery("INSERT INTO chatlog_tx_hidden (h, since, src) VALUES (?, ?, 'pepe')", [hash(l), T0]);
  await runQuery("INSERT INTO chatlog_hidden (h, since, src, scopes) VALUES (?, ?, 'pepe', ?)", [hash("all4"), T0, JSON.stringify({ bridge: T0, incognito: T0 })]);
  for (const l of ["cam_only", "all4", "inc_cam"]) await LC.setOptout(l, true, { via: "web", ts: T0 });
  await runQuery("INSERT INTO chatlog_hidden (h, since, src, scopes) VALUES (?, ?, 'pepe', ?)", [hash("inc_cam"), T0, JSON.stringify({ incognito: T0 })]);
  // Pepe's incognito reports (linked logins): "both" reported on (comes back after !bridge show), "stale" reported off
  await runQuery(`INSERT INTO incognito_state (login, "on", updated, reported, via) VALUES ('both', 1, ?, ?, 'chat'), ('stale', 0, ?, ?, 'chat')`, [T0, T0, T0, T0]);
  await CL._restartHidden();
  Q.setHidden([], []);
})();

test("S2 privacyeff.raw / eff: what the site applies, from the real stores", async () => {
  await setup;
  const F = (o) => ({ ...OFF(PE.SWITCHES), ...o });
  const cases = {
    nobody: F({}),
    inc_only: F({ incognito: true }),
    web_on: F({ incognito: true }),                     // a website ON Pepe hasn't confirmed: veiled at once
    hide_only: F({ bridge_off: true }),
    both: F({ bridge_off: true }),                      // incognito + !bridge hide: the stricter kind (stated() keeps both)
    forgot: F({ bridge_off: true }),                    // forget-me: left out (stricter than bridge off)
    unknown: F({ bridge_off: true }),                   // a kind the site can't tell: fail closed
    tx_only: F({ tx_off: true }),
    tx_hide: F({ bridge_off: true, tx_off: true }),
    cam_only: F({ livecam_off: true }),
    inc_cam: F({ incognito: true, livecam_off: true }),
    all4: F({ bridge_off: true, tx_off: true, livecam_off: true }),
  };
  for (const [l, want] of Object.entries(cases)) {
    for (const form of [l, l.toUpperCase(), "@" + l, ` ${l} `]) {
      assert.deepEqual(PE.raw(form), want, `raw(${form})`);
      assert.deepEqual(PE.eff(form), PE.effOf(want), `eff(${form})`);
      assert.equal(PE.eff(form).name, Q.isHidden(l), `the name flag IS quotes.isHidden (${form})`);
    }
  }
  assert.deepEqual(PE.eff("inc_only"), { ...OFF(PE.FLAGS), name: true }, "incognito hides the name only");
  assert.deepEqual(PE.eff("cam_only"), { ...OFF(PE.FLAGS), cam: true }, "!livecam off hides the cam only");
  assert.deepEqual(PE.eff("tx_only"), { ...OFF(PE.FLAGS), tx: true }, "!transcripts off blacks out the 🎙 only");
  assert.deepEqual(PE.eff("hide_only"), { ...OFF(PE.FLAGS), name: true, chat: true, tx: true, cam: true, out: true }, "bridge off: all but the voice");
  for (const blank of [null, "", "  ", "@"]) assert.deepEqual(PE.raw(blank), OFF(PE.SWITCHES), `blank ${JSON.stringify(blank)}`);
});

test("S2 privacyeff.raw: fails closed while the sets load or a source can't be read", async () => {
  await setup;
  const realLoading = HH.loading, realTx = CL.isTxHiddenKey, realOpt = LC.optedOut;
  try {
    HH.loading = () => true;
    assert.deepEqual(PE.raw("nobody"), { ...OFF(PE.SWITCHES), bridge_off: true }, "hubhidden loading: everyone left out");
    HH.loading = realLoading;
    CL.isTxHiddenKey = () => { throw new Error("boom"); };
    LC.optedOut = () => { throw new Error("boom"); };
    assert.deepEqual(PE.raw("nobody"), { ...OFF(PE.SWITCHES), tx_off: true, livecam_off: true }, "a reader that throws counts as on");
  } finally {
    HH.loading = realLoading;
    CL.isTxHiddenKey = realTx;
    LC.optedOut = realOpt;
  }
});

test("S2 privacyeff.stated: the person's own switches (what comes back after !bridge show)", async () => {
  await setup;
  const S = async (l) => { const s = await PE.stated(l); delete s.login; return s; };
  const F = (o) => ({ ...OFF(PE.SWITCHES), left_out: false, reported: false, ...o });
  assert.deepEqual(await S("both"), F({ incognito: true, bridge_off: true, reported: true }), "incognito survives under bridge off");
  assert.deepEqual(await S("inc_only"), F({ incognito: true }), "an unreported incognito: the set's incognito kind");
  assert.deepEqual(await S("stale"), F({ reported: true }), "Pepe's OFF report is their switch");
  assert.deepEqual(await S("hide_only"), F({ bridge_off: true }));
  assert.deepEqual(await S("forgot"), F({ left_out: true }), "forget-me is not their bridge switch - left out");
  assert.deepEqual(await S("unknown"), F({ left_out: true }), "a kind the site can't tell - left out, no switch claimed");
  assert.deepEqual(await S("all4"), F({ incognito: true, bridge_off: true, tx_off: true, livecam_off: true }));
  assert.deepEqual(await S("inc_cam"), F({ incognito: true, livecam_off: true }));
  assert.deepEqual(await S("nobody"), F({}));
  assert.deepEqual(PE.effOf(await PE.stated("both")), PE.eff("both"), "bridge off: the stored switches mean what the site applies");
  assert.deepEqual(await PE.stated(""), { login: null, ...F({}) });
});
