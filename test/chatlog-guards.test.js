// CL2 guards for the chat archive: every DDL / trigger statement parses in the VPS's sqlite3 CLI 3.31 (no iif(), ->>,
// unixepoch(), STRICT, RETURNING - the CLI must be able to hand-edit chat_log with the triggers in place); the new modules are
// Node 16-safe (the VPS runs Node 16: no global fetch, zlib.crc32, findLast / toSorted / structuredClone ...); the lists other
// files keep in step with chatlog.js (keep-staging-tables KEEP, padrekey ROOM_BOUND, the indexable rule, the private_args
// commands, the capability); the switch defaults (dark: only purge on).
//   node --test test/chatlog-guards.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-guards-")));     // chatlog.js loads dbUtils (./myapp.db)
delete process.env.CHATLOG_DB;
const CL = require(path.join(repo, "chatlog"));

const DDL_BANNED = [/\biif\s*\(/i, /->>/, /\bunixepoch\s*\(/i, /\bSTRICT\b/, /\bRETURNING\b/i];

test("the archive's DDL and triggers use nothing the VPS's sqlite3 3.31 CLI lacks", () => {
  const all = [...CL.MAIN_DDL, ...CL.ARCHIVE_DDL, CL.FTS_DDL, ...CL.TRIGGERS.map(([, s]) => s)];
  assert.ok(all.length >= 20);
  for (const s of all) for (const re of DDL_BANNED) assert.doesNotMatch(s, re, `${re} in: ${s.slice(0, 80)}`);
  // and the modules' whole source: no runtime SQL relies on them either (CL3: the read side and the settings too)
  for (const f of ["chatlog.js", "chatlogview.js", "padchat.js", "chatlogmod.js",                         // CL6: + the takedowns
                   "chatloghist.js",                                                                       // CL8: + scrollback
                   "chatlogsearch.js",                                                                     // CL9: + search
                   "chatlogpurge.js",                                                                     // CL7: + the retention purge
                   "chatlogexport.js"]) {                                                                 // CL10: + the downloads
    const src = fs.readFileSync(path.join(repo, f), "utf8").replace(/^\s*\/\/.*$/gm, "");     // code, not the comments
    for (const re of [/\biif\s*\(/i, /\bunixepoch\s*\(/i, /\bRETURNING\b/, /->>/]) assert.doesNotMatch(src, re, f);
  }
  assert.match(CL.FTS_DDL, /tokenize = 'unicode61 remove_diacritics 2'/, "unicode61 (the 3.31 CLI has no trigram)");
  assert.match(CL.FTS_DDL, /content = 'chat_log', content_rowid = 'c'/, "external content: the text is stored once");
});

test("the new modules are Node 16-safe (the VPS runs Node 16)", () => {
  const files = ["chatlog.js", "chatlogdb.js", "tools/chatlog-bench.js", "chatlogview.js", "padchat.js",   // CL3: + the read side, the settings
                 "public/js/chatlog-core.js",                                                                 // CL5: the one renderer (the downloads run it in Node)
                 "chatlogmod.js",                                                                             // CL6: the takedowns
                 "chatloghist.js",                                                                            // CL8: scrollback
                 "chatlogsearch.js",                                                                          // CL9: search
                 "chatlogpurge.js", "premium.js",                                                             // CL7: the retention purge (+ Pepe's report time)
                 "chatlogexport.js", "tz-core.js",                                                            // CL10: the downloads (+ the zone offset they date by)
                 // CL2 fix-up: every other file CL2 changed runs on the VPS's Node 16 too
                 "bridge.js", "incognito.js", "terms.js", "roomsweb.js", "accountMerge.js", "accountdelete.js", "accountexport.js",
                 "padrekey.js", "siteperms-core.js", "tools/remove-stray-pad.js", "tools/scrub-consent-feed.js", "deploy/keep-staging-tables.js",
                 "micrec.js", "actorcap.js", "premiumperks.js", "botupload.js"];                            // mic retention
  const banned = [/\.findLast(Index)?\(/, /\.toSorted\(/, /\.toReversed\(/, /\.toSpliced\(/, /\bstructuredClone\(/, /\bzlib\.crc32\b/,
                  /\bObject\.hasOwn\(/, /\.at\(-?\d/, /(^|[^.\w])fetch\(/m, /\bAbortSignal\.timeout\(/, /\barray\.group/i];
  for (const f of files) {
    const src = fs.readFileSync(path.join(repo, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
    for (const re of banned) assert.doesNotMatch(src, re, `${f}: ${re}`);
  }
});

test("the lists kept in step with chatlog.js", () => {
  const K = require(path.join(repo, "deploy", "keep-staging-tables"));
  assert.deepEqual([...K.CHATLOG].sort(), [...CL.TABLES].sort(), "keep-staging-tables keeps every archive table");
  for (const t of CL.TABLES) assert.ok(K.KEEP.includes(t), t + " is KEEP");
  assert.equal(K.INDEXABLE, CL.INDEXABLE, "the same indexable rule");
  assert.deepEqual(K.CHATLOG_TRIGGERS, CL.TRIGGERS.map(([n]) => n));
  const RK = require(path.join(repo, "padrekey"));
  for (const t of ["chatlog_rooms", "chat_log", "chatlog_open", "chatlog_reports", "chatlog_holds", "chatlog_views", "chatlog_exports"]) assert.ok(RK.ROOM_BOUND.has(t), t);
  assert.ok(!RK.ROOM_BOUND.has("pad_chat_cfg"), "the pad's settings move with the pad");
  for (const c of ["!msg", "!message", "!patvmsg", "!verify", "!verifypad", "!joinroom", "!padfine", "!relay", "!tell"]) assert.ok(CL.PRIVATE_ARGS.includes(c), c);
  assert.ok(CL.PRIVATE_ARGS.includes("!padmove"), "padfine's alias");
  const core = require(path.join(repo, "siteperms-core"));
  const cap = core.capOf("chatlog.admin");
  assert.ok(cap && cap.def === "admin" && cap.locked === "privacy", "chatlog.admin: admins, privacy-locked");
  const ra = core.capOf("chatlog.read_all");
  assert.ok(ra && ra.def === "staff" && ra.locked === "privacy", "CL6 chatlog.read_all: Staff and up, privacy-locked");
  assert.equal(require(path.join(repo, "chatlogview")).READ_ALL, "chatlog.read_all", "the read side asks the same key");
  assert.equal(require(path.join(repo, "chatlogmod")).READ_ALL, "chatlog.read_all");
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.ok(en["siteperm.k.chatlog.admin"]);
  assert.ok(en["siteperm.k.chatlog.read_all"]);
  // CL6: the takedown index is a partial one (only taken-down rows), on the archive's DDL list
  assert.ok(CL.ARCHIVE_DDL.some((s) => /chat_log_rm ON chat_log \(rk, rm_at\) WHERE rm_at IS NOT NULL/.test(s)));
});

test("CL6: the takedown decisions as constants (decision 12, §3.11)", () => {
  const M = require(path.join(repo, "chatlogmod"));
  assert.equal(M.KEEP_RM_MS, 30 * 864e5, "a hidden line's text: 30 days for the owner and staff");
  assert.equal(M.UNHIDE_MS, 30 * 864e5);
  assert.equal(M.VIEWS_KEEP_MS, 730 * 864e5, "the staff read audit: 2 years");
  assert.equal(M.REPORTS_PER_HOUR, 20);
  assert.equal(M.ACT_PER_MIN, 30);
  assert.deepEqual([...M.REASONS], ["info", "harassment", "sexual", "minor", "copyright"]);
  assert.deepEqual([...M.ADMIN_ONLY], ["minor", "copyright"]);
  assert.deepEqual([...M.URGENT], ["minor"]);
  assert.equal(M.REMOVED_MAX, 500);
  assert.equal(M.BATCH, 1000);
});

test("CL8: scrollback's limits as constants (§2.2, §3.11); the browser module is plain ES5", () => {
  const CH = require(path.join(repo, "chatloghist"));
  assert.equal(CH.PAGE, 50, "50 lines at a time");
  assert.equal(CH.LIMIT_MAX, 100);
  assert.equal(CH.PER_MIN, 60, "60 requests a minute (viewers without full history)");
  assert.equal(CH.DAY_ITEMS, 20000, "20,000 items a day (viewers without full history)");
  const V = require(path.join(repo, "chatlogview"));
  assert.equal(V.PRESENCE_MS, 24 * 3600e3, "decision 10: presence 24 h");
  const src = fs.readFileSync(path.join(repo, "public", "js", "pad-history.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  for (const re of [/\.findLast(Index)?\(/, /\.toSorted\(/, /\bstructuredClone\(/, /\bObject\.hasOwn\(/, /\.at\(-?\d/, /\.replaceAll\(/,
    /=>/, /\blet\s/, /\bconst\s/, /`/, /\.\.\.\w/, /\bclass\s+\w/, /\?\./, /\?\?/]) assert.doesNotMatch(src, re, "pad-history.js: " + re);
  assert.match(src, /var CAP = 3000, LIVE_KEEP = 300, PAGE = 50;/, "the 3,000-node reading-back model; the live tail's 300; pages of 50");
  assert.doesNotMatch(src, /console\.(log|info)\(/, "nothing logs a line");
});

test("CL9: search's rules and limits as constants (decision 11, §2.3, §3.5, §3.11); the browser module is plain ES5", () => {
  const CS = require(path.join(repo, "chatlogsearch"));
  assert.equal(CS.PAGE, 20, "20 results at a time");
  assert.equal(CS.LIMIT_MAX, 50);
  assert.equal(CS.ROWS, 200, "one fetch of 200 candidates");
  assert.equal(CS.PREFIX_MIN, 3, "decision 11: the last word is a prefix from 3 letters");
  assert.equal(CS.TERM_MIN, 2, "at least one word of 2 letters");
  assert.equal(CS.TERMS_MAX, 8);
  assert.equal(CS.Q_MAX, 100);
  assert.equal(CS.PER_MIN, 20, "20 searches a minute");
  assert.equal(CS.PER_DAY, 300, "300 a day");
  assert.equal(CS.LIKE_ROWS, 20000, "the LIKE fallback's window");
  assert.equal(CL.RT_SHARE, 0.25, "the room token below a quarter of the indexed rows");
  const DB = require(path.join(repo, "chatlogdb"));
  assert.equal(DB.SEARCH_BUDGET_MS, 400);
  assert.equal(DB.SEARCH_QUEUE, 4);
  const src = fs.readFileSync(path.join(repo, "public", "js", "pad-search.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  for (const re of [/\.findLast(Index)?\(/, /\.toSorted\(/, /\bstructuredClone\(/, /\bObject\.hasOwn\(/, /\.at\(-?\d/, /\.replaceAll\(/,
    /=>/, /\blet\s/, /\bconst\s/, /`/, /\.\.\.\w/, /\bclass\s+\w/, /\?\./, /\?\?/]) assert.doesNotMatch(src, re, "pad-search.js: " + re);
  // never snippet(): it would quote redacted names; never a GET with the query in the URL
  const s2 = fs.readFileSync(path.join(repo, "chatlogsearch.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(s2, /\bsnippet\s*\(|\bhighlight\s*\(/);
  assert.doesNotMatch(s2, /app\.get\(/);
  assert.doesNotMatch(s2, /console\.(log|info|warn)\(/);
});

test("ships dark: every switch off but purge; the owner-decision constants", () => {
  assert.deepEqual(CL.SWITCHES, { notice: false, archive: false, history: false, search: false, downloads: false, purge: true });
  const c = CL.cfg();
  assert.equal(c.notice, false);
  assert.equal(c.archive, false);
  assert.equal(CL.NOTICE_DAYS, 7);
  assert.equal(CL.SEED_AT_SWITCH_ON, true);
  assert.equal(CL.PERK_ROOMS_ONLY, true);
  assert.equal(CL.TRIP_AFTER, 20);
  assert.equal(CL.BOOT_EID_MS, 10 * 60e3);
  assert.equal(CL.REPAIR_BATCH, 5000);
  assert.equal(CL.LIST_RACE_MS, 10 * 60e3, "CL2 fix-up: a list entry this close to a typed hide was that hide");
});

test("rowOf: what a feed item becomes (the mapper the seed shares)", () => {
  const r = CL.rowOf({ it: { c: 7, k: "msg", ts: 123, text: "hi", u: { login: "Bob", display: "Bob B", on_cam: true, on_mic: true, src: "list", web: true }, _job: "w1" },
                      eid: "e1", mid: "m1" }, 3, "p");
  assert.deepEqual({ ...r, d: JSON.parse(r.d) }, { c: 7, rk: 3, ts: 123, k: "msg", who: "bob", text: "hi", rt: "r3", aud: "p",
                                                   d: { u: { display: "Bob B", web: true } }, mid: "m1", tx: null, eid: "e1" });
  const a = CL.rowOf({ it: { c: 8, k: "msg", ts: 1, text: "web", u: { login: "u:ABC-123456", display: "Ann", acct: true, web: true } } }, 3, "m");
  assert.equal(a.who, "u:abc-123456", "a web member's account key, lower-cased");
  const j = CL.rowOf({ it: { c: 9, k: "join", ts: 1, u: { anon: true, display: "someone" } } }, 3, "m");
  assert.equal(j.who, null, "an anonymised person has no key");
  assert.equal(j.text, null);
  const l = CL.rowOf({ it: { c: 10, k: "live", ts: 1, who: "pb", pad: "Pad", what: "x", link: "/p/x", np: 1 } }, 3, "m");
  assert.deepEqual(JSON.parse(l.d), { who: "pb", pad: "Pad", what: "x", link: "/p/x", np: 1 });
  assert.equal(l.who, null);
});

test("1.99afn: the privacy commands are on the site's private_args floor, and the help sync's TOP-LEVEL private_args list is read", async () => {
  // the backup copy (bot 1.99afk's pepe_privargs.BUILTIN floor): a pad never shows "X: !incognito on" even before a help sync lands
  for (const c of ["!incognito", "!forgetme", "!bridge", "!transcripts"]) {
    assert.ok(CL.PRIVATE_ARGS.includes(c), c);
    assert.equal(CL.isPrivateCmd(c + " on"), true, c);
    assert.equal(CL.isPrivateCmd(c.toUpperCase() + " status"), true, c + " in any case");
  }
  assert.equal(CL.isPrivateCmd("!bridges"), false, "a whole first word only");
  // Pepe's build (camfrog-bot tools/build_help.py) publishes ONE top-level list and no per-card flag - the site used to read only
  // the per-card flag, so nothing was ever added
  const H = require(path.join(repo, "help"));
  const real = H.current;
  H.current = async () => ({ data: { schema: 1, categories: [], private_args: ["!newsecret", "!AliasOfIt", "not a command", 7, "!" + "x".repeat(60)],
                                     entries: [{ id: "a", commands: ["!plain"], aliases: [] }, { id: "b", commands: ["!oldflag"], aliases: ["!oldalias"], private_args: true }] } });
  try {
    const n = await CL.privateFromHelp();
    assert.equal(n, 4, "the list's two good commands + an older build's flagged card (command + alias)");
    for (const c of ["!newsecret", "!aliasofit", "!oldflag", "!oldalias"]) assert.equal(CL.isPrivateCmd(c + " 1234"), true, c);
    assert.equal(CL.isPrivateCmd("!plain x"), false, "an unflagged card is not private");
    assert.equal(CL.isPrivateCmd("not a command"), false);
    assert.equal(CL.isPrivateCmd("!incognito on"), true, "the floor stays");
  } finally { H.current = real; }
  // the real help data Pepe publishes carries the list (bot 1.99afk on): when the bot checkout is next to the site, it is the same shape
  const botData = path.join(repo, "camfrog-bot", "help", "help-data.json");
  if (fs.existsSync(botData)) {
    const d = JSON.parse(fs.readFileSync(botData, "utf8"));
    assert.ok(Array.isArray(d.private_args), "help-data.json has the top-level list");
  }
});

test("review fix: the privacy policy's never-kept list names every command on the site's private_args floor (it can't trail PRIVATE_ARGS again)", () => {
  const src = fs.readFileSync(path.join(repo, "views", "privacy.ejs"), "utf8");
  const m = src.match(/neither are the commands that carry private text or codes \(([\s\S]*?)\.\s/);
  assert.ok(m, "the sentence is there");
  const listed = new Set([...m[1].matchAll(/<code>(![a-z0-9_]+)<\/code>/gi)].map((x) => x[1].toLowerCase()));
  for (const c of CL.PRIVATE_ARGS) assert.ok(listed.has(c), `${c} is in chatlog.PRIVATE_ARGS but not in privacy.ejs's never-kept list`);
});
