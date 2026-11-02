// privacyeff.js — ONE answer to "what does the website do with this person right now?" (1.99?? privacy controls S2).
//
// The owner's model (2026-11-02, G:/ops/privacy-controls-spec-2026-11-02.md sections 1.2 and 8): every website privacy switch does
// one job and they combine freely. `!bridge hide` is an OVERRIDE, not a setter: it turns every website switch on without changing
// the stored ones, and `!bridge show` puts the person back on their own. Pepe's memory (`!remember`, memoryoptout.js) is not a
// website switch and is not part of this (bridge off never changes it - owner Q2). Pepe's twin of this module: pepe_privacy.py.
//
//   stored switch   owner      the site keeps it in                                  typed as
//   incognito       Pepe       the sticky hidden sets' incognito kind (chatlog_hidden    !incognito on (also Settings -> Privacy)
//                              reasons + hubhidden.js), incognito_state (his reports)
//   bridge_off      Pepe       the sticky sets' "out" kind (chatlog_hidden reason        !bridge hide
//                              `bridge`; hubhidden's LEFT)
//   tx_off          Pepe       chatlog_tx_hidden (chatlog.isTxHiddenKey)                 !transcripts off
//   livecam_off     the site   livecam_optout (livecam.optedOut)                         !livecam off (also Settings -> Live cam)
//   chat_off        (S8, future !chatrelay off - no list yet: always off)
//   mic_off         (S9, future !micrelay off - no list yet: always off)
//
//   effective flag  on when                                   the website then
//   name            incognito OR bridge_off                   shows a frog name ("someone" on privacy wire v1)
//   chat            chat_off OR bridge_off                    blacks out their chat lines
//   tx              tx_off OR bridge_off                      blacks out their 🎙 transcripts
//   cam             livecam_off OR bridge_off                 withholds their cam (a cover / hood instead)
//   voice           mic_off (+ bridge_off once BRIDGE_MUTES)  mutes their voice on the website's audio (S9/S10: not built)
//   out             bridge_off                                (the override itself)
//
//   effOf(raw)      the model: stored switches -> effective flags (pure)
//   raw(login)      what the site APPLIES now, synchronously, from what it keeps in memory: incognito / bridge_off are
//                   quotes.isIncognito / isBridgeOff (the two halves of quotes.isHidden - bridge_off here is "left out": !bridge
//                   hide or anything stricter, forget-me / deletion / staff removal / a kind the site can't tell, and everyone
//                   while a hidden set loads), tx_off chatlog.isTxHiddenKey (everyone until its set loads), livecam_off
//                   livecam.optedOut. A source that can't be read counts as ON (fail closed).
//   eff(login)      effOf(raw(login)): {name, chat, tx, cam, voice, out}
//   stated(login)   async: the person's OWN switches as stored - what comes back after !bridge show (Pepe's incognito report in
//                   incognito_state, else the incognito kind; the `bridge` reason, never a protected one; chatlog_tx_hidden;
//                   livecam_optout) + left_out (forget-me / deletion / staff removal / a kind the site can't tell). For the
//                   Settings card (S6); effOf(stated) is what those switches mean.
//
// S2 is a refactor: nothing reads a flag differently from before (quotes.isHidden is exactly isIncognito || isBridgeOff).
"use strict";

const SWITCHES = Object.freeze(["incognito", "bridge_off", "tx_off", "livecam_off", "chat_off", "mic_off"]);
const FLAGS = Object.freeze(["name", "chat", "tx", "cam", "voice", "out"]);
// S10: once micrelay off ships (S9), bridge off mutes the voice too. Until then a hidden person is still heard (the `hm` audio
// marker is not a mute).
const BRIDGE_MUTES = false;

const low = (s) => String(s == null ? "" : s).trim().replace(/^@/, "").toLowerCase().slice(0, 64);

/** The owner's model: stored switches ({switch: bool}, missing = off) -> the effective flags ({flag: bool}). */
function effOf(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const on = (k) => r[k] === true || r[k] === 1;
  const out = on("bridge_off");
  return {
    name: out || on("incognito"),
    chat: out || on("chat_off"),
    tx: out || on("tx_off"),
    cam: out || on("livecam_off"),
    voice: on("mic_off") || (BRIDGE_MUTES && out),
    out,
  };
}

/** One reader, fail closed: a module that can't be loaded or a reader that throws counts as ON. */
function ask(mod, fn, key) {
  try {
    const M = require(mod);
    return typeof M[fn] === "function" ? !!M[fn](key) : true;
  } catch (e) { return true; }
}

/** What the site applies to `login` now ({switch: bool}) - synchronous, from memory (see the header). */
function raw(login) {
  const out = Object.fromEntries(SWITCHES.map((k) => [k, false]));
  const l = low(login);
  if (!l) return out;
  out.bridge_off = ask("./quotes", "isBridgeOff", l);
  out.incognito = ask("./quotes", "isIncognito", l);
  out.tx_off = ask("./chatlog", "isTxHiddenKey", l);
  out.livecam_off = ask("./livecam", "optedOut", l);
  return out;
}

/** `login`'s effective website privacy now: {name, chat, tx, cam, voice, out}. */
const eff = (login) => effOf(raw(login));

/** The person's own switches as stored (see the header): {login, incognito, bridge_off, tx_off, livecam_off, chat_off, mic_off,
 *  left_out, reported} - `reported` = Pepe has reported their incognito (a linked login's incognito_state row). */
async function stated(login) {
  const l = low(login);
  const out = Object.assign({ login: l || null }, Object.fromEntries(SWITCHES.map((k) => [k, false])), { left_out: false, reported: false });
  if (!l) return out;
  const CL = require("./chatlog");
  await CL.init();
  const kinds = CL.kindsOf(CL.hash(l));
  out.bridge_off = kinds.includes("bridge");
  out.left_out = kinds.includes("protected") || kinds.includes("unknown");
  out.tx_off = !!CL.isTxHiddenKey(l);
  const INC = require("./incognito");
  await INC.init();
  const { getQuery } = require("./dbUtils");
  const r = (await getQuery(`SELECT "on" AS "on" FROM incognito_state WHERE login = ?`, [l]))[0];
  out.reported = !!r;
  out.incognito = r ? !!Number(r.on) : kinds.includes("incognito");
  const LC = require("./livecam");
  await LC.init();
  out.livecam_off = !!LC.optedOut(l);
  return out;
}

module.exports = { SWITCHES, FLAGS, BRIDGE_MUTES, effOf, raw, eff, stated };
