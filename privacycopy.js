// privacycopy.js — 1.99aid (privacy controls S7): WHICH privacy text shows (G:/ops/privacy-controls-spec-2026-11-02.md section 5
// "S7" + section 6, updated for the owner's answers in section 8). Each slice's text ships behind that slice's switch, like wave 2's
// (privwire.privacyCopy): it shows while the switch is on - its advert, i.e. the switch AND privacy wire v2, which every one of them
// needs - and its change note is dated by the switch's FIRST ON (chatlog_meta first_on), which also moves /privacy's "Last updated"
// (terms.js). No re-acceptance (terms VERSION unchanged).
//
//   incogcam    S5 incognito cams (incogcams.js, switch incog_cams): incognito hides the NAME, not the cam (Q4, Q23)
//   camreveal   S4 cam reveals (camreveal.js, switch cam_reveal): moderators view a hidden cam, told unless ghost (Q8-Q11, Q13, Q15, Q22)
//   camevidence S4's evidence stills / clips (camevidence.js - cam reveals AND evidence clips; Q12): also while any is still kept, like
//               evidence.privacyCopy (the copies exist); dated by the later of the two switches' first ON
//   pv3         S6 the privacy switchboard v3 (privacystate.js, switch privacy_v3): one switch at a time, !privacy, room lines (Q20)
//   textreveal  1.99aid S4t text reveal roles (textreveal.js, switch text_reveal_roles): staff and room mods reveal hidden text too
//   wcover      1.99aif (privacy controls round 5) S3's cover picture (micfollow_cfg withheld_cover - no privacy wire needed): a cam opt-out
//               shows on mic stages with their cover picture. {on: true} while the knob is on - not dated (the knob keeps no first ON)
//
// load() -> {incogcam, camreveal, camevidence, pv3}: each {on, on_at, on_day} or null (off - the text is exactly as before). Used by
// /privacy (terms.js), /settings/privacy (incognito.js) and, through flags(), /help (help.js). Never throws.
"use strict";
const { getQuery } = require("./dbUtils");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayText = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

function copyOf(st) {
  if (!st || st.advert !== true) return null;
  const at = Number(st.first_on) > 0 ? Number(st.first_on) : null;
  return { on: true, on_at: at, on_day: at ? dayText(at) : null };
}
async function stateOf(file) {
  try { const M = require(file); await M.init(); return M.state(); } catch (e) { return null; }
}

/** The four copies (see the header). */
async function load() {
  const out = { incogcam: null, camreveal: null, camevidence: null, pv3: null, textreveal: null, wcover: null };
  out.wcover = wcoverOn() ? { on: true, on_at: null, on_day: null } : null;   // (1.99aif privacy controls round 5)
  out.incogcam = copyOf(await stateOf("./incogcams"));
  out.textreveal = copyOf(await stateOf("./textreveal"));          // 1.99aid (privacy controls S4t)
  const crs = await stateOf("./camreveal");
  out.camreveal = copyOf(crs);
  out.pv3 = copyOf(await stateOf("./privacystate"));
  try {
    let ev = null;
    try { ev = await require("./evidence").privacyCopy(); } catch (e) { ev = null; }
    const on = !!(out.camreveal && ev && ev.on);
    let n = 0;
    try { n = Number((await getQuery("SELECT COUNT(*) AS n FROM cam_evidence"))[0].n) || 0; } catch (e) { n = 0; }
    if (on || n) {
      const ats = [crs && Number(crs.first_on) > 0 ? Number(crs.first_on) : null, ev && ev.on_at ? Number(ev.on_at) : null].filter(Boolean);
      const at = ats.length ? Math.max(...ats) : null;
      out.camevidence = { on, any: n > 0, on_at: at, on_day: at ? dayText(at) : null };
    }
  } catch (e) { out.camevidence = null; }
  return out;
}

/** Synchronous: which slices' text is on now (their adverts) - /help's cards (help.js withPrivacyCopy). Fails closed. */
function flags() {
  const adv = (file) => { try { return require(file).advert() === true; } catch (e) { return false; } };
  return { incogcam: adv("./incogcams"), camreveal: adv("./camreveal"), privstate: adv("./privacystate"), textreveal: adv("./textreveal"),
           wcover: wcoverOn() };   // (1.99aif privacy controls round 5)
}
/** 1.99aif (privacy controls round 5): is micfollow_cfg withheld_cover on (S3: a cam opt-out shows on mic stages with their cover picture)?
 *  Fails closed. */
function wcoverOn() { try { return require("./micfollow").withheldCover() === true; } catch (e) { return false; } }

module.exports = { load, flags, dayText };
