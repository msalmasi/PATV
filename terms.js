// terms.js — the Terms of Service + Privacy Policy pages and acceptance (1.99cc).
//
//   /terms, /privacy               the pages (views/terms.ejs, views/privacy.ejs), "Last updated" = UPDATED / PRIVACY_UPDATED
//   POST /api/terms/accept         the signed-in user accepts the current VERSION (the composer's prompt)
//   users.terms_accepted_version / users.terms_accepted_at (ms)   recorded at sign-up (the web form) and
//                                  the first time someone posts or comments after VERSION changed
//   needs(userId)                  true when the user hasn't accepted VERSION yet (feedweb's posting gate)
//   enforced()                     1.99cf: is acceptance required at all? The admin switch terms_enforced
//                                  (/feed/admin, feedstore config, default OFF) AND no [[PLACEHOLDER]] left in
//                                  views/terms.ejs + views/privacy.ejs. Off: the pages show a "Draft" banner,
//                                  nobody is asked to accept, sign-up records nothing.
//   placeholders()                 the [[...]] markers still in those two pages ({page, text}); while any
//                                  remain the switch can't be turned on (feedstore.setConfig refuses)
//
// Bump VERSION (and the page's UPDATED) when the terms change materially: everyone is asked once more, the next
// time they post.
"use strict";
const fs = require("fs");
const path = require("path");
const { runQuery, getQuery } = require("./dbUtils");

const VERSION = "2026-10-11";   // 1.99nt: the user asked everyone to accept the §10 premium/donations/prizes terms
// 1.99nn: the "Last updated" date is per page and moves without VERSION: an additive change (the §10 premium,
// donations and prizes section) updates the date but asks nobody to accept again. Bump VERSION too to re-ask.
// 1.99ans (NY S5935-A, owner 2026-11-11): sections 9 / 10 say every prize is virtual and donations give perks, never PAT. The date
// moves; VERSION (re-acceptance) is NOT bumped here - whether members must accept again is the owner's decision.
const UPDATED = "11 November 2026";                // /terms
const PRIVACY_UPDATED = "28 October 2026";         // /privacy (WP-1's "your voice is still heard" is dated by TEXT_DATES below - the day this server first served it; mic retention review 2: the deleted accounts' Camfrog-name markers in sections 10 and 9 - additive, VERSION unchanged; the owner approved the text on 2026-10-27 (ops plan mic-audio-retention 8.5 A) and it merged to staging on 28 October 2026 - this date and its changelog entry; 1.99afn: the never-kept commands list matches chatlog.PRIVATE_ARGS - + !patvmsg, !padmove and the privacy commands - additive, VERSION unchanged; date it the day it reaches prod; S1 F13:the patv_chat_sweep sign-out cookie in section 8 - additive, VERSION unchanged; photos sent to Pepe in DMs - additive, VERSION unchanged; the owner's rule of 2026-10-19 (1.99add refix 4 + the chat-history owner change): incognito hides who, not what - "someone"; !bridge hide left out - additive, VERSION unchanged; CL11 + CL13: messages from Camfrog, the admin's own Camfrog log - additive, VERSION unchanged; 1.99acd: browser notifications - additive, VERSION unchanged; 1.99aax: live cams + ghost mode, forget me, export / delete, no crawlers)

// 1.99aft (review): a privacy-text change dated the day THIS server first served it - policy_text_dates keeps that first moment
// per text, so staging and prod each date it when it reached them and nobody hand-edits a date at the promote (a hard-coded day
// was false whenever the promote slipped). /privacy's "Last updated" and the change note use it. WP-1's "your voice is still
// heard" (incognito/mic-stage design section H, owner-approved 2026-10-28: section 3 and the incognito bullets - additive,
// VERSION unchanged) is the first. Recorded at boot (register).
// mic keep (handoff 16 follow-up, owner 2026-11-01): "mic-stage-keep" = section 3's Mic-stage snaps and clips paragraph (additive,
// VERSION unchanged). Published (and dated) the first time /privacy is served with mic-stage captures switched on (mainstage
// stagecap_mic), not at boot: while they are off it would describe a feature nobody can use, next to today's incognito bullet.
// Once published it stays, so a later switch-off still describes the copies that exist.
// 1.99aht transcripts bar (owner 2026-11-02): "tx-bar" = the !transcripts off blacked-out bar sentences (sections 3 and 10, the change note),
// shown while privacy wire v2 is on AND the latest Pepe sends those 🎙 lines as a bar (privwire.txBar) - dated the first time /privacy
// is served that way. Review fix (F1): once the bar stops being live (a bot rollback) the bars it made are still kept and revealable,
// so while any is left the page says THAT instead ("kept": new ones left out, the shown ones stay bars; a change note dated by when
// the bar stopped - privwire.txOff); with none left it reads as wave 2 did, and the tx-bar date no longer counts toward "Last updated".
// 1.99ahx frog names (owner 2026-11-03, "Lets do 2"): "frog-15" = section 10's incognito bullet now saying "someone" lasts 15 minutes after
// being seen by name, then a frog name (it said "until your next visit") - inside the privacy wire v2 text, so dated the first time /privacy
// is served with that switch on, and its date counts toward "Last updated" only while the switch is on.
// 1.99aid (privacy controls S0, spec 4.1): "livecam-never-kept" = !livecam joins section 3's list of privacy settings a pad's chat
// history never keeps (chatlog.PRIVATE_ARGS; additive, VERSION unchanged). That list is shown only while the chat archive's notice
// is on (chatlog.policy), so the change is dated the first time /privacy is served with it showing - never while nobody can read it.
// 1.99aid (privacy controls S7, spec section 5 "S7": "PRIVACY_UPDATED moves; no re-accept"): the privacy text of S4 / S5 / S6 is dated
// like wave 2's - by its switch's first ON (privacycopy.js), not by a hand-edited PRIVACY_UPDATED - so "Last updated" moves on the day
// each switch first goes on, on each server, and never before; VERSION (re-acceptance) doesn't move.
// 1.99aih (privacy controls round 6): "stage-cover" = S3's cover-picture sentences (micfollow_cfg withheld_cover - privacycopy wcover:
// section 3's privacy-wire paragraph, its Mic-stage snaps and clips paragraph and the Live cams bullets, 1.99aif round 5 and round 6),
// shown only while that knob is on - dated the first time /privacy is served with it on (the knob keeps no first ON of its own), and
// its date counts toward "Last updated" only while the knob is on (like frog-15)
// 1.99ajn padppl (owner 2026-11-04, "Yes" to bumping UPDATED): "rooms-web-2" = section 3's people-list sentence with the dimmed "posted in
// the last hour" rows (shown while the Room Dock is on - dated its first serve that way, counts only while it shows); "net-bans" = section
// 4's network-code paragraph (netban.js, shown and dated only while network bans are on); "blocks-2" = section 6's paragraph on what a
// block does (the person menu, profiles, frog names); "chat-mentions" = pad chat @mentions alert you by default, and incognito lines can
// alert the person they name under the frog name (section 10's promise changes) - both always shown, dated their first serve.
// "gift-inbox" = section 6's gifts-to-frog-names paragraph (veilgift.js), shown and dated only while those gifts are switched on
// audiogate2: "net-bans-2" = the network-bans paragraph's "and listening to a pad's room audio" (listenban.js) - shown with that paragraph,
// dated its first serve that way (the paragraph's own "net-bans" date may be older), counts only while it shows
const TEXT_DATES = ["wp1-voice", "mic-stage-keep", "tx-bar", "frog-15", "livecam-never-kept", "stage-cover", "rooms-web-2", "net-bans", "blocks-2", "chat-mentions", "gift-inbox", "net-bans-2"];
const SWITCHED_TEXTS = { "mic-stage-keep": () => require("./mainstage").config().stagecap_mic === true,
                         "rooms-web-2": () => require("./paddock").current().cfg.mode !== "off",
                         "net-bans": () => require("./netban").hasDataNow() === true,     // (review fix: while ANY code is stored, switch or not)
                         "net-bans-2": () => require("./netban").hasDataNow() === true,   // (audiogate2: shown with net-bans)
                         "gift-inbox": () => require("./veilgift").isOn() === true,
                         "tx-bar": () => require("./privwire").txBar() === true,
                         "frog-15": () => require("./privwire").isOn() === true,
                         "livecam-never-kept": () => { const c = require("./chatlog").cfg(); return !!(c && c.notice && c.notice_at); },
                         "stage-cover": () => require("./micfollow").withheldCover() === true };   // (1.99aih privacy controls round 6)
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayText = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
let datesReady = null;
function initDates() {
  if (!datesReady) {
    datesReady = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS policy_text_dates (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
      for (const k of TEXT_DATES) if (!SWITCHED_TEXTS[k]) await runQuery("INSERT OR IGNORE INTO policy_text_dates (key, at) VALUES (?, ?)", [k, Date.now()]);
    })().catch((e) => { datesReady = null; throw e; });
  }
  return datesReady;
}
/** {key: {at, day}}: when this server first served each dated text. Never throws ({} on an error: the note shows undated). */
async function textDates() {
  try {
    await initDates();
    for (const [k, on] of Object.entries(SWITCHED_TEXTS)) {
      let live = false;
      try { live = on(); } catch (e) { live = false; }
      if (live) await runQuery("INSERT OR IGNORE INTO policy_text_dates (key, at) VALUES (?, ?)", [k, Date.now()]);
    }
    const out = {};
    for (const r of await getQuery("SELECT key, at FROM policy_text_dates")) {
      if (TEXT_DATES.includes(r.key) && Number(r.at) > 0) out[r.key] = { at: Number(r.at), day: dayText(Number(r.at)) };
    }
    return out;
  } catch (e) { return {}; }
}

const padwebOn = () => { try { return require("./paddock").current().cfg.mode !== "off"; } catch (e) { return false; } };
// (1.99ajn padppl review fix: section 4's network-code paragraph shows while network bans are on OR any code is still stored - netban.hasData)
const netbanOn = () => { try { const NB = require("./netban"); NB.hasData().catch(() => {}); return NB.hasDataNow() === true; } catch (e) { return false; } };
const giftsOn = () => { try { return require("./veilgift").isOn() === true; } catch (e) { return false; } };

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      const cols = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
      if (!cols.size) return;                     // no users table (a bare test DB)
      if (!cols.has("terms_accepted_version")) {
        try { await runQuery("ALTER TABLE users ADD COLUMN terms_accepted_version TEXT"); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
      }
      if (!cols.has("terms_accepted_at")) {
        try { await runQuery("ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER"); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
      }
    })().catch((e) => { console.error("[terms] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

// ── 1.99cf: the switch (set by feedstore from its config; default OFF) ──
let SETTING = false;
let OVERRIDE = null;                              // tests: true / false forces the gate, null follows the setting
/** feedstore calls this whenever its config loads or changes (terms_enforced). */
function setEnforced(on) { SETTING = !!on; }
/** Tests of other features switch the posting gate off (null = follow the admin setting again). */
function _setRequired(on) { OVERRIDE = on == null ? null : !!on; }

// The [[PLACEHOLDER]] markers left in the two pages: PH('...') calls and literal [[...]] text. Re-read when a
// file changes (mtime), so filling them in and deploying is enough.
const PAGES = [["terms", path.join(__dirname, "views", "terms.ejs")], ["privacy", path.join(__dirname, "views", "privacy.ejs")]];
const PH_CALL = /\bPH\(\s*(['"`])((?:(?!\1).)*)\1\s*\)/g;
const PH_TEXT = /\[\[([^\[\]]{1,200})\]\]/g;
const EJS_COMMENT = /<%#[\s\S]*?%>/g;
let phCache = { key: "", list: [] };
let phOverride = null;                            // tests: a fixed list
function _setPlaceholders(list) { phOverride = list == null ? null : list.slice(); }
function placeholders() {
  if (phOverride) return phOverride.slice();
  let key = "";
  for (const [, f] of PAGES) { try { key += fs.statSync(f).mtimeMs + ";"; } catch (e) { key += "missing;"; } }
  if (key === phCache.key) return phCache.list.slice();
  const list = [];
  for (const [page, f] of PAGES) {
    let src = "";
    try { src = fs.readFileSync(f, "utf8"); } catch (e) { list.push({ page, text: "(page missing)" }); continue; }
    const seen = new Set();
    for (const line of src.replace(EJS_COMMENT, "").split(/\r?\n/)) {
      if (/\bconst\s+PH\s*=/.test(line)) continue;            // the helper itself
      for (const m of line.matchAll(PH_CALL)) seen.add(m[2].trim());
      for (const m of line.replace(PH_CALL, "").matchAll(PH_TEXT)) seen.add(m[1].trim());
    }
    for (const t of seen) list.push({ page, text: t });
  }
  phCache = { key, list };
  return list.slice();
}
/** Acceptance is required: the admin switch is on and the pages are finished (or a test forced it). */
function enforced() {
  if (OVERRIDE !== null) return OVERRIDE;
  return SETTING && placeholders().length === 0;
}
const required = enforced;

async function accepted(userId) {
  await init();
  const r = (await getQuery("SELECT terms_accepted_version AS v, terms_accepted_at AS at FROM users WHERE userId = ?", [String(userId || "")]))[0];
  return r ? { version: r.v || null, at: r.at || null } : null;
}
/** True when this user still has to accept the current terms before posting. */
async function needs(userId) {
  if (!userId || !enforced()) return false;
  const a = await accepted(userId);
  return !!a && a.version !== VERSION;
}
/** Record acceptance of the current VERSION (idempotent: the first acceptance time is kept). */
async function accept(userId) {
  if (!userId) return false;
  await init();
  const r = await runQuery("UPDATE users SET terms_accepted_version = ?, terms_accepted_at = ? WHERE userId = ? AND (terms_accepted_version IS NULL OR terms_accepted_version != ?)",
                           [VERSION, Date.now(), String(userId), VERSION]);
  return !!r.changes;
}

function register(app, { addUser }) {
  init().catch(() => {});
  initDates().catch((e) => console.error("[terms] text dates:", e.message));
  // every page rendered after this: may it say "By posting / signing up you agree to the Terms"?
  app.use((req, res, next) => { res.locals.termsEnforced = enforced(); next(); });
  const page = (view, title, path, updated) => async (req, res, next) => {
    res.locals.og = { title: title + " — Public Access TV", description: title + " for publicaccess.tv.", image: (res.locals.ogBase || "") + require("./og").pageUrl(title),
                      url: (res.locals.ogBase || "") + path };
    // CL2: from the moment the chat archive's notice switch is on, /privacy states it (chatlog.policy: null while it's off) -
    // its date becomes the page's "Last updated" when it is the newer one; additive, so VERSION (re-acceptance) doesn't move
    // S1 V4: likewise the paragraph on chat lines and account deletion (the chat hub + that archive) from the moment the hub's
    // erasure switch is on (accountdelete.privacyCopy: null while it's off); "Last updated" = the newest of the dates
    // mic retention (micrec.js): the mic-recordings policy text from the moment its switch is first turned on (micrec.privacyCopy:
    // null while it's off) - additive, so VERSION doesn't move; its day becomes "Last updated" when it is the newest. 1.99afv
    // review: so does rule_at - the day the published unknown-room rule / date last changed (an off / on that publishes a new one)
    // wave 3 (design §N.8): the 🧠 "Pepe's memory" text from the moment Pepe's latest report has the memory switch
    // (memoryoptout.privacyCopy: null otherwise - after a rollback too); its day is when a Pepe first reported it
    // wave 2 (design section H): the frog-name / hidden text from the moment the Privacy wire v2 switch is on (privwire.privacyCopy:
    // null while it's off - the page reads exactly as before); dated by G, its first ON
    // wave 2 WP-5 (section H, approved 2026-10-28 / 2026-11-01): the evidence-clip sentence, its section 9 row and its changelog clause
    // from the moment evidence clips can be made (evidence.privacyCopy: its switch AND privacy wire v2), and while any are still kept;
    // null otherwise - the page reads exactly as before. Its first switch-on date joins "Last updated"
    // 1.99aid (privacy controls S7): the text of S4 (cam reveals + their evidence), S5 (incognito cams) and S6 (the privacy switchboard
    // v3), each while its switch is on (privacycopy.js - like wave 2: null otherwise, the page reads exactly as before); each change
    // note is dated by its switch's first ON, which joins "Last updated". Additive: VERSION (re-acceptance) doesn't move
    let chatlog = null, hubErasure = null, micrec = null, memory = null, privwire = null, evidence = null, policyDates = {}, txbar = null;
    let pcopy = { incogcam: null, camreveal: null, camevidence: null, pv3: null };
    if (view === "privacy") {
      try { chatlog = await require("./chatlog").policy(); } catch (e) { chatlog = null; }
      try { hubErasure = await require("./accountdelete").privacyCopy(); } catch (e) { hubErasure = null; }
      try { micrec = await require("./micrec").privacyCopy(); } catch (e) { micrec = null; }
      try { memory = await require("./memoryoptout").privacyCopy(); } catch (e) { memory = null; }
      try { await require("./privwire").init(); privwire = require("./privwire").privacyCopy(); } catch (e) { privwire = null; }
      // 1.99aht transcripts bar: its text only inside the privwire branches, only while it is live (privwire.txBar)
      // (review fix F1: "kept" while the bar isn't live but bars it made are still kept - privwire.txTextNow)
      try {
        const PWm = require("./privwire");
        const m = privwire ? await PWm.txTextNow() : null;
        txbar = m === "live" ? { on: true } : m === "kept" ? { kept: true, ...(PWm.txOff() || {}) } : null;
      } catch (e) { txbar = null; }
      try { evidence = await require("./evidence").privacyCopy(); } catch (e) { evidence = null; }
      policyDates = await textDates();                // 1.99aft: the texts dated the day this server first served them
      try { pcopy = await require("./privacycopy").load(); } catch (e) { /* the page as before */ }
    }
    let upd = updated, updAt = Date.parse(updated + " 23:59:59 UTC");
    for (const [at, day] of [[chatlog && chatlog.notice_at, chatlog && chatlog.notice_day], [hubErasure && hubErasure.on_at, hubErasure && hubErasure.on_day],
                             [micrec && micrec.on_at, micrec && micrec.on_day], [micrec && micrec.rule_at, micrec && micrec.rule_day],   // 1.99afv review
                             [memory && memory.on_at, memory && memory.on_day], [privwire && privwire.g, privwire && privwire.g_day],
                             [evidence && evidence.on_at, evidence && evidence.on_day],
                             [txbar && txbar.kept && txbar.off_at, txbar && txbar.kept && txbar.off_day],   // (review fix F1: the "kept" note)
                             ...Object.values(pcopy).map((c) => [c && c.on_at, c && c.on_day]),
                             ...Object.entries(policyDates).filter(([k]) => k !== "tx-bar" || txbar).filter(([k]) => k !== "frog-15" || privwire).filter(([k]) => k !== "stage-cover" || pcopy.wcover)
                               .filter(([k]) => k !== "rooms-web-2" || padwebOn()).filter(([k]) => (k !== "net-bans" && k !== "net-bans-2") || netbanOn()).filter(([k]) => k !== "gift-inbox" || giftsOn())   // (1.99ajn padppl)
                               .map(([, d]) => [d.at, d.day])]) {
      if (at && day && at > updAt) { upd = day; updAt = at; }
    }
    // (S7's copies ride res.locals: the view reads them as locals.incogcam / camreveal / camevidence / pv3 - null on /terms)
    Object.assign(res.locals, { incogcam: pcopy.incogcam, camreveal: pcopy.camreveal, camevidence: pcopy.camevidence, pv3: pcopy.pv3,
                                textreveal: pcopy.textreveal,      // (1.99aid privacy controls S4t)
                                wcover: pcopy.wcover });           // (1.99aif privacy controls round 5: S3's cover picture, micfollow_cfg withheld_cover)
    // 1.99ajf dockclean (Room Dock clean-up, owner point 32): the web-users-on-a-pad sentence, while the Room Dock (which lists them) is on
    try { res.locals.padweb = require("./paddock").current().cfg.mode !== "off"; } catch (e) { res.locals.padweb = false; }
    res.locals.netban = netbanOn();                                  // 1.99ajn padppl: section 4's network codes, only while network bans are on
    res.locals.giftsOn = giftsOn();                                  // 1.99ajn padppl: section 6's gifts to frog names, only while they are on
    try { res.render(view, { user: req.user ? req.user.username : null, title, VERSION, UPDATED: upd, enforced: enforced(), chatlog, hubErasure, micrec, memory, txbar, privwire, evidence, policyDates }); } catch (e) { next(e); }
  };
  app.get("/terms", addUser, page("terms", "Terms of Service", "/terms", UPDATED));
  app.get("/privacy", addUser, page("privacy", "Privacy Policy", "/privacy", PRIVACY_UPDATED));
  app.get(["/tos", "/terms-of-service"], (req, res) => res.redirect(301, "/terms"));
  app.get("/privacy-policy", (req, res) => res.redirect(301, "/privacy"));
  app.post("/api/terms/accept", addUser, async (req, res) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    let same = true;
    if (src && host) { try { same = new URL(src).host === host; } catch (e) { same = false; } }
    if (!same || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      await accept(req.user.userId);
      res.json({ ok: true, version: VERSION });
    } catch (e) {
      console.error("[terms] accept:", e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
}

module.exports = { VERSION, UPDATED, PRIVACY_UPDATED, TEXT_DATES, textDates, init, needs, accept, accepted, register, required, enforced, setEnforced, placeholders, _setRequired, _setPlaceholders };
