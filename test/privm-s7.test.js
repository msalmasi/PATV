// 1.99aid (privacy controls S7): THE PRIVACY TEXT of slices S4 (cam reveals + their evidence), S5 (incognito cams) and S6 (the
// privacy switchboard v3) - G:/ops/privacy-controls-spec-2026-11-02.md section 5 "S7" + section 6, updated for the owner's answers
// (section 8). Each slice's text ships behind that slice's switch; each change note is dated by its switch's first ON (terms.js
// "Last updated", like wave 2); no re-acceptance. On a temp DB:
//   copies    privacycopy.load(): null per slice while its switch (advert) is off; {on, on_at, on_day} = its first ON while on;
//             cam evidence = cam reveals AND evidence clips, or any kept; flags() = the adverts
//   policy    /privacy (the real route): each slice's sentences only with its switch, dated notes newest first, "Last updated";
//             the owner's answers in the words (Q4 the name only, Q8 who, Q11 never who, Q12 evidence, Q13, Q22, Q23); no S1 / S3
//             words; switches off -> byte for byte the S6 head's page (golden, the base template rendered with the same data)
//   settings  /settings/privacy: the S5 / S4 keys only with their switch, the client's OFF line follows; every key in en.json;
//             switches off -> byte for byte the S6 head's view
//   help      Pepe's cards' "pc" variants (help.js withPrivacyCopy): only with a switch on, a slice whose swaps don't fit is left out
//             whole; Pepe's real help data (PEPE_BOT_DIR) applies whole in every combination
//   notice    the live-cam OFF inbox notice adds the moderation sentence only while cam reveals are on
//   node --test test/privm-s7.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-s7-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.ALIAS_SECRET = "cd".repeat(32);
process.env.EVIDENCE_DIR = path.join(tmp, "evidence");
const express = require("express");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const TERMS = require(path.join(repo, "terms"));
TERMS._setRequired(false);
const PW = require(path.join(repo, "privwire"));
const IC = require(path.join(repo, "incogcams"));
const CR = require(path.join(repo, "camreveal"));
const PS = require(path.join(repo, "privacystate"));
const EV = require(path.join(repo, "evidence"));
const PC = require(path.join(repo, "privacycopy"));
const HELP = require(path.join(repo, "help"));
const EN = require(path.join(repo, "locales", "en.json"));
const BASE = process.env.PRIVM_S7_BASE_REV || "5b4d6076";   // (the S6 head as rebased onto 1.99aib; was 4e6d14c9 on 1.99ahz, 3a6208c0 on 1.99ahx, 90869346 on 1.99aht, b2f60207 before)

const users = new Map();
const U = {};
let base, server;
const D = (y, m, d) => Date.UTC(y, m - 1, d, 12);
let T = D(2026, 11, 3);
for (const M of [IC, CR, PS, EV]) M._setClock(() => T);

function call(method, url, { user = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const h = Object.assign({ "x-requested-with": "fetch", origin: base, host: u.host }, user ? { "x-test-user": user.userId } : {});
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { s += c; });
      res.on("end", () => resolve({ status: res.statusCode, text: s }));
    });
    req.on("error", reject);
    req.end();
  });
}
async function mkUser(name, cls = "pleb", camfrog = null) {
  const uid = "id-" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00')`, [uid, name, name, cls, camfrog]);
  const u = { userId: uid, username: name, class: cls, camfrogUsername: camfrog };
  users.set(uid, u);
  return u;
}
const ADM = () => ({ userId: U.adm.userId, username: "adm", class: "Admin" });
const strip = (html) => html.replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
async function setAll({ ic = false, cr = false, pv = false, ev = false } = {}) {
  await IC.setOn(ic, ADM());
  await CR.setOn(cr, ADM());
  await PS.setOn(pv, ADM());
  await EV.setOn(ev, ADM());
}

const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await require(path.join(repo, "inbox")).ready;
  U.bob = await mkUser("bob", "pleb", "Bob123");
  U.adm = await mkUser("adm", "Admin", "admcf");
  const app = express();
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  TERMS.register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  for (const M of [PW, IC, CR, PS, EV]) await M.init();
  await require(path.join(repo, "camevidence")).init();
})();

// ── the copies ──
test("privacycopy: null while each switch is off; on = its advert; dated by its first ON; cam evidence = reveals AND evidence", async () => {
  await setup;
  let c = await PC.load();
  assert.deepEqual(c, { incogcam: null, camreveal: null, camevidence: null, pv3: null, textreveal: null }, "everything off");   // (1.99aid S4t: + textreveal)
  assert.deepEqual(PC.flags(), { incogcam: false, camreveal: false, privstate: false, textreveal: false });
  await PW.setOn(true, ADM());
  c = await PC.load();
  assert.deepEqual(c, { incogcam: null, camreveal: null, camevidence: null, pv3: null, textreveal: null }, "privacy wire alone: nothing");
  T = D(2026, 11, 4);
  await IC.setOn(true, ADM());
  T = D(2026, 11, 6);
  await CR.setOn(true, ADM());
  T = D(2026, 11, 8);
  await PS.setOn(true, ADM());
  c = await PC.load();
  assert.deepEqual(c.incogcam, { on: true, on_at: D(2026, 11, 4), on_day: "4 November 2026" });
  assert.deepEqual(c.camreveal, { on: true, on_at: D(2026, 11, 6), on_day: "6 November 2026" });
  assert.deepEqual(c.pv3, { on: true, on_at: D(2026, 11, 8), on_day: "8 November 2026" });
  assert.equal(c.camevidence, null, "no evidence switch: no evidence text");
  assert.deepEqual(PC.flags(), { incogcam: true, camreveal: true, privstate: true, textreveal: false });
  T = D(2026, 11, 9);
  await EV.setOn(true, ADM());
  c = await PC.load();
  assert.deepEqual(c.camevidence, { on: true, any: false, on_at: D(2026, 11, 9), on_day: "9 November 2026" }, "the later of the two first ONs");
  // off and on again: the first ON stays the date
  T = D(2026, 11, 10);
  await IC.setOn(false, ADM());
  assert.equal((await PC.load()).incogcam, null, "off: the text goes (like wave 2)");
  await IC.setOn(true, ADM());
  assert.equal((await PC.load()).incogcam.on_day, "4 November 2026", "on again: dated by the FIRST on");
  // privacy wire off: every slice's text goes (they all need it)
  await PW.setOn(false, ADM());
  c = await PC.load();
  assert.equal(c.incogcam || c.camreveal || c.pv3 || (c.camevidence && c.camevidence.on), null, "privacy wire off: none");
  // a kept cam evidence row keeps its retention text after the switches went off
  await runQuery(`INSERT INTO cam_evidence (id, room_id, subject_login, kind, file, by_user, role, created, expires_at)
                  VALUES ('ce0000000000000001', 'room1', 'bob123', 'still', 'x.jpg', 'id-adm', 'admin', ?, ?)`, [T, T + 30 * 864e5]);
  c = await PC.load();
  assert.equal(c.camevidence.on, false);
  assert.equal(c.camevidence.any, true, "kept evidence: the row stays in section 9");
  await runQuery("DELETE FROM cam_evidence");
  await PW.setOn(true, ADM());
});

// ── the policy page ──
const S5_WORDS = ["Incognito hides your name, not your cam", "Your cam isn't part of", "<b>Captures of you:</b>",
                  "hides only your name (sections 3 and 10)"];
const S4_WORDS = ["Moderation views of a hidden cam:", "someone moderating the pad viewed it, never who",
                  "and of moderation views of hidden cams", "PATV staff and room moderators can't reveal names or read hidden lines"];
const S6_WORDS = ["one switch at a time", "<code>!privacy</code> shows your settings", "Bridge off (<code>!bridge hide</code>) turns on every",
                  "covers only the name you typed it under", "Your website privacy switches (sections 3 and 10)"];
const EV_WORDS = ["<b>Evidence:</b>", "Moderation evidence stills and clips of a hidden cam"];
const has = (html, words) => words.filter((w) => html.includes(w));

test("/privacy: each slice's sentences only with its switch; notes dated by first ON, newest first; Last updated", async () => {
  await setup;
  await setAll({});
  let html = (await call("GET", "/privacy")).text;
  for (const w of [...S5_WORDS, ...S4_WORDS, ...S6_WORDS, ...EV_WORDS]) assert.ok(!html.includes(w), "off: " + w);
  assert.ok(html.includes("Either way your cam is never shown on the website."), "off: today's wave-2 text");
  const only = async (sw, own) => {
    await setAll(sw);
    const h = (await call("GET", "/privacy")).text;
    for (const [words, mine] of [[S5_WORDS, own === "ic"], [S4_WORDS, own === "cr"], [S6_WORDS, own === "pv"]]) {
      assert.deepEqual(has(h, words), mine ? words : [], `${own}: ${mine ? "all of its own" : "none of another's"} words`);
    }
    return h;
  };
  html = await only({ ic: true }, "ic");
  assert.ok(!html.includes("Either way your cam is never shown") && html.includes("live and on a pad's mic stage"), "S5 replaces the promise");
  assert.ok(html.includes("<code>!incognito</code> hides your name, not your cam") && html.includes("doesn't change Pepe's own <code>!snap</code>"),
            "S5: the Live cams bullet (Q16 in it)");
  html = await only({ cr: true }, "cr");
  for (const w of ["PATV administrators and staff (anywhere), a pad's owner (in their own pad) and the room's moderators (in their room)",
                   "They have to give a reason", "for 3 minutes at a time", "never who", "ghost mode", "kept for 180 days",
                   "where its mirror or its cams are off, nobody can view a cam this way",
                   "only PATV administrators and staff - and, while you're in their room, the pad's owner and the room's moderators - can, and only your cam - never your name or your past lines",
                   " or <code>!incognito</code>)"]) assert.ok(html.includes(w), "S4 (Q8 / Q11 / Q13 / Q15 / Q22): " + w);
  assert.ok(!html.includes("except as moderation evidence") && !html.includes("<b>Evidence:</b>"), "no evidence switch: no evidence sentence");
  html = await only({ pv: true }, "pv");
  assert.ok(html.includes("(and, for now, keeps your cam off the website)") && html.includes(", and for now your cam"),
            "S6 without S5: incognito still keeps the cam off - said so");
  // all of them + evidence: the combined text, dated notes
  T = D(2026, 11, 20);
  await setAll({ ic: true, cr: true, pv: true, ev: true });
  html = (await call("GET", "/privacy")).text;
  const ALL = [...S5_WORDS.slice(1), ...S4_WORDS, ...S6_WORDS, ...EV_WORDS];      // (with S6 the rooms paragraph is S6's: its own S5 clause)
  assert.deepEqual(has(html, ALL), ALL);
  assert.ok(html.includes(" - your name only, not your cam;") && !html.includes("(and, for now, keeps your cam off the website)")
            && !html.includes(", and for now your cam"), "S6 + S5: the name only");
  assert.ok(html.includes("except as moderation evidence (below)") && html.includes("up to 30 seconds, no sound") && html.includes("30 days"),
            "S4 + evidence (Q12)");
  assert.ok(html.includes("(<code>!livecam off</code> or <code>!bridge hide</code>), limited who can watch"), "S4 + S5: incognito is no hiding of the cam");
  const notes = [...html.matchAll(/<li><b>(\d{1,2} \w+ 2026):<\/b> ([^<]{0,40})/g)].map((m) => m[1]);
  const i8 = notes.indexOf("8 November 2026"), i6 = notes.indexOf("6 November 2026"), i4 = notes.indexOf("4 November 2026");
  assert.ok(i8 >= 0 && i6 > i8 && i4 > i6, "the three notes, newest first: " + notes.slice(0, 6).join(" | "));
  assert.ok(notes.includes("9 November 2026"), "evidence on a later day: its own note");
  const lu = /Last updated:?\s*(?:<[^>]+>\s*)*([0-9]{1,2} \w+ 2026)/.exec(html);
  assert.ok(lu && lu[1] === "9 November 2026", "Last updated = the newest first ON: " + (lu && lu[1]));
  // the words (the owner's answers)
  const text = strip(html);
  for (const w of ["cover picture", "transcript hidden", "!micrelay", "!chatrelay", "blacks out your mic transcripts", "a PATV admin viewed"]) {
    assert.ok(!text.includes(w), "no S1 / S3 / future / naming words: " + w);
  }
  assert.ok(text.includes("they may guess who you are"), "Q23: followers may guess who the frog is");
  assert.ok(text.includes("always under your frog name, never your name, and a capture of it never appears on your profile"), "Q4: captures");
});

test("/privacy golden: every S7 switch off -> byte for byte the S6 head's page", async () => {
  await setup;
  let baseSrc = null;
  try { baseSrc = execFileSync("git", ["-C", repo, "show", `${BASE}:views/privacy.ejs`], { encoding: "utf8" }); } catch (e) { baseSrc = null; }
  if (!baseSrc) return;
  const now = fs.readFileSync(path.join(repo, "views", "privacy.ejs"), "utf8").replace(/\r\n/g, "\n");   // (a CRLF checkout)
  baseSrc = baseSrc.replace(/\r\n/g, "\n");
  const fn = path.join(repo, "views", "privacy.ejs");
  const L0 = { user: null, title: "Privacy Policy", VERSION: TERMS.VERSION, UPDATED: TERMS.PRIVACY_UPDATED, enforced: false, chatlog: null,
               hubErasure: null, micrec: null, memory: null, privwire: null, evidence: null, policyDates: {}, ogBase: "http://test" };
  const PWC = { on: true, g: D(2026, 10, 28), g_day: "28 October 2026" };
  const variants = [{}, { privwire: PWC }, { privwire: PWC, evidence: { on: true, any: false, on_at: D(2026, 11, 1), on_day: "1 November 2026" } },
                    { privwire: PWC, memory: { on_at: D(2026, 10, 28), on_day: "28 October 2026" }, policyDates: { "wp1-voice": { at: D(2026, 10, 29), day: "29 October 2026" } } },
                    { incogcam: null, camreveal: null, camevidence: null, pv3: null, privwire: PWC }];
  for (const v of variants) {
    const loc = Object.assign({}, L0, v);
    assert.equal(ejs.render(now, loc, { filename: fn }), ejs.render(baseSrc, loc, { filename: fn }), "same page: " + Object.keys(v).join(","));
  }
});

// ── Settings → Privacy ──
function pageLocals(extra) {
  return Object.assign({ user: "bob", st: { linked: true, login: "bob123", account: false, on: false, updated: null, reported: null, waiting: null, failed: null, log: [] },
                         lc: { linked: true, login: "bob123", off: true }, oa: { linked: true, on: false }, gh: { on: false }, pf: null, slChat: false, slOk: false,
                         mf: null, micrecOn: false, mem: null, pwOn: true, ogBase: "http://test" }, extra || {});
}
const SFN = path.join(repo, "views", "privacy-settings.ejs");
const render = (src, locals) => ejs.render(src, locals, { filename: SFN });

test("settings: S5 / S4 words only with their switch; the client's OFF line follows; every key in en.json", async () => {
  const src = fs.readFileSync(SFN, "utf8");
  const P = { effective: true, linked: true, login: "bob123", bridge: { on: false, waiting: null }, tx: { on: false, waiting: null },
              incognito: { on: false, waiting: null }, livecam: { off: true }, log: [] };
  const off = render(src, pageLocals({ pv3: P }));
  for (const k of ["inc.what_web_someone_v2_ic", "inc.what_media_someone_ic", "pv3.name_meta_ic", "lc.chat_ic", "oa.what_never_ic",
                   "lc.what_told_rv", "lc.st_off_rv", "pv3.cam_meta_rv", "gh.what_reveal"]) assert.ok(!off.includes(EN[k]), "off: " + k);
  assert.ok(!off.includes("I.s['js.lc.st_off']"), "off: no client override");
  const ic = render(src, pageLocals({ pv3: P, icOn: true }));
  for (const k of ["inc.what_web_someone_v2_ic", "inc.what_media_someone_ic", "pv3.name_meta_ic", "lc.chat_ic", "oa.what_never_ic"]) {
    assert.ok(ic.includes(EN[k].replace(/'/g, "&#39;")) || ic.includes(EN[k]), "S5: " + k);
  }
  for (const k of ["inc.what_web_someone_v2", "inc.what_media_someone", "pv3.name_meta", "lc.chat", "oa.what_never"]) assert.ok(!ic.includes(EN[k]), "S5 replaces " + k);
  const acct = render(src, pageLocals({ icOn: true, st: { linked: true, login: "bob123", account: true, on: false, log: [] } }));
  assert.ok(acct.includes(EN["inc.what_web_someone_acct_v2_ic"]), "S5: the account variant");
  const crv = render(src, pageLocals({ pv3: P, crvOn: true }));
  for (const k of ["lc.what_told_rv", "lc.st_off_rv", "pv3.cam_meta_rv", "gh.what_reveal"]) assert.ok(crv.includes(EN[k]), "S4: " + k);
  assert.ok(crv.includes("I.s['js.lc.st_off'] = " + JSON.stringify(EN["lc.st_off_rv"])), "S4: the client's OFF line follows");
  for (const k of ["inc.what_web_someone_v2_ic", "pv3.name_meta_ic"]) assert.ok(!crv.includes(EN[k]), "S4 alone: no S5 words " + k);
  // the words
  assert.ok(EN["lc.st_off_rv"].includes("never who") && EN["lc.st_off_rv"].includes("ghost mode") && EN["lc.what_told_rv"].includes("never who"), "Q11");
  assert.ok(EN["inc.what_media_someone_ic"].includes("never your name") && EN["inc.what_web_someone_v2_ic"].includes("doesn't hide your cam"), "Q4");
  for (const m of src.matchAll(/\bt\('([a-z0-9_.]+)'/g)) if (!m[1].endsWith(".")) assert.ok(m[1] in EN, "en.json: " + m[1]);
});

test("settings golden: icOn / crvOn off -> byte for byte the S6 head's view", async () => {
  let baseSrc = null;
  try { baseSrc = execFileSync("git", ["-C", repo, "show", `${BASE}:views/privacy-settings.ejs`], { encoding: "utf8" }); } catch (e) { baseSrc = null; }
  if (!baseSrc) return;
  const now = fs.readFileSync(SFN, "utf8").replace(/\r\n/g, "\n");   // (a CRLF checkout)
  baseSrc = baseSrc.replace(/\r\n/g, "\n");
  const P = { effective: true, linked: true, login: "bob123", bridge: { on: true, waiting: null }, tx: { on: false, waiting: null },
              incognito: { on: true, waiting: null }, livecam: { off: false }, log: [] };
  for (const extra of [{}, { pv3: P }, { lc: { linked: true, login: "bob123", off: false } }, { pwOn: false },
                       { st: { linked: false, login: null, account: false, on: null, log: [] }, lc: { linked: false } },
                       { st: { linked: true, login: "bob123", account: true, on: true, log: [] }, icOn: false, crvOn: false }]) {
    assert.equal(render(now, pageLocals(extra)), render(baseSrc, pageLocals(extra)), "same HTML: " + Object.keys(extra).join(","));
  }
});

// ── /help ──
test("help: the cards' pc variants only with a switch on; a slice that doesn't fit is left out whole; Pepe's data applies whole", async () => {
  await setup;
  const card = { id: "livecam", summary: "S", details: "one two three",
                 pc: { camreveal: { swap: [["one", "1"]] }, incogcam: { summary: "S5", swap: [["two", "2"], ["missing", "x"]] }, privstate: { swap: [["three", "3"]] } } };
  await setAll({});
  assert.equal(HELP.withPrivacyCopy([card])[0], card, "switches off: the very same card");
  await setAll({ cr: true, ic: true, pv: true });
  const got = HELP.withPrivacyCopy([card, { id: "x", summary: "y" }]);
  assert.deepEqual([got[0].summary, got[0].details], ["S", "1 two 3"], "incogcam's swaps don't fit: left out whole, the others made");
  assert.equal(got[1].summary, "y");
  assert.deepEqual(HELP.pcApply("S", "a b", { incogcam: { swap: [["a", "A"]] } }, { incogcam: false }), { summary: "S", details: "a b", applied: [] });
  assert.equal(HELP.pcApply("S", "a a", { incogcam: { swap: [["a", "A"]] } }, { incogcam: true }).applied.length, 0, "an old text found twice: not applied");
  assert.deepEqual(HELP.PC_KEYS, ["camreveal", "incogcam", "privstate", "textreveal"], "the bot's order (pepe_privtext.PC_KEYS; 1.99aid S4t: + textreveal)");
  const bot = process.env.PEPE_BOT_DIR;
  if (bot && fs.existsSync(path.join(bot, "help", "help-data.json"))) {
    const data = JSON.parse(fs.readFileSync(path.join(bot, "help", "help-data.json"), "utf8"));
    const cards = data.entries.filter((e) => e.pc);
    assert.ok(cards.length >= 8, "Pepe's data carries the variants");
    for (const e of cards) {
      const keys = HELP.PC_KEYS.filter((k) => e.pc[k]);
      const s0 = e.v2 && e.v2.summary ? e.v2.summary : e.summary, d0 = e.v2 && e.v2.details ? e.v2.details : e.details;
      // 1.99aid (privacy controls, landed on 1.99aht): a card with a v2tx wording (read while the transcripts bar is on) has two bases -
      // the bot's build_help rule: in each combination every slice applies whole to at least one, and on the other it is whole too or
      // not there at all (none of its old texts in that wording as it stands then); a card without v2tx: whole on its one base
      const vt = e.v2tx && typeof e.v2tx === "object" ? e.v2tx : null;
      const bases = vt ? [[s0, d0], [vt.summary || s0, vt.details || d0]] : [[s0, d0]];
      for (let mask = 1; mask < 1 << keys.length; mask++) {
        const act = Object.fromEntries(keys.map((k, i) => [k, !!(mask >> i & 1)]));
        const want = keys.filter((k) => act[k]), hit = new Set();
        for (const [s, d] of bases) {
          const r = HELP.pcApply(s, d, e.pc, act);
          r.applied.forEach((k) => hit.add(k));
          if (!vt) assert.deepEqual(r.applied, want, `${e.id} ${JSON.stringify(act)} applies whole`);
          for (const k of want.filter((x) => !r.applied.includes(x))) {
            const before = Object.fromEntries(keys.map((j) => [j, act[j] && HELP.PC_KEYS.indexOf(j) < HELP.PC_KEYS.indexOf(k)]));
            const dk = HELP.pcApply(s, d, e.pc, before).details;
            assert.ok(!(e.pc[k].swap || []).some((p) => dk.includes(p[0])), `${e.id} ${JSON.stringify(act)}: ${k} never half made`);
          }
          assert.ok(r.details.length <= HELP.HELP_LIMITS.details, e.id + " fits");
        }
        assert.deepEqual(want.filter((k) => hit.has(k)), want, `${e.id} ${JSON.stringify(act)} applies whole to a wording`);
      }
    }
  }
  await setAll({});
});

// ── the live-cam notice ──
test("notice: the live-cam OFF inbox notice adds the moderation sentence only while cam reveals are on", async () => {
  await setup;
  await PW.setOn(true, ADM());
  await setAll({ pv: true });
  PS.noteBot({ privstate: 1 }, T);
  await PS.camChanged("bob123", true, "chat", T);
  await setAll({ pv: true, cr: true });
  PS.noteBot({ privstate: 1 }, T);
  await PS.camChanged("bob123", true, "chat", T + 1);
  const rows = await getQuery("SELECT body FROM inbox WHERE user_id = ? AND title LIKE '%hidden from the website%' ORDER BY id", [U.bob.userId]);
  assert.equal(rows.length, 2, JSON.stringify(rows));
  assert.ok(!rows[0].body.includes("Moderators"), "cam reveals off: today's words");
  assert.ok(rows[1].body.includes("Moderators can still view it for moderation - Pepe tells you when they do."), "cam reveals on: + the sentence");
  await setAll({});
});
