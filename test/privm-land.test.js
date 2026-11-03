// 1.99aid (privacy controls, landed on origin/staging 1.99aht transcripts bar): S4t's text reveal roles (switch text_reveal_roles) meet
// the transcripts bar's sentences that name who can reveal the words.
//   /privacy  every transcripts-bar sentence that names who can reveal (section 3, the chat history, the incognito section - live and
//             "kept") names PATV staff and the room's moderators too, with a reason, while text reveal roles are on; off: byte for byte
//             the page without them
//   /help     help.js's own transcripts card (PRIVWIRE_TX_CARDS), its "kept" note and a Pepe's v2tx card the same (txTr); Pepe's pc
//             "textreveal" swap on the v2tx card then finds nothing to do - one set of words, never doubled
//   reveals   a room moderator / staff member reveals a transcripts bar (scope tx_line, their role) - the merged see-through loop
//   node --test test/privm-land.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-land-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";

// the switches as the help pipeline reads them (privwire / textreveal), stubbed in the require cache before help.js loads
const SW = { pw: true, tx: true, kept: false, tr: false };
const stub = (name, exp) => {
  const f = require.resolve(path.join(repo, name));
  require.cache[f] = { id: f, filename: f, loaded: true, exports: exp };
};
stub("privwire", { isOn: () => SW.pw, txBar: () => SW.tx, txKept: () => SW.kept });
stub("textreveal", { isOn: () => SW.tr, advert: () => SW.tr });
stub("privacycopy", { flags: () => ({ textreveal: SW.tr }) });
const H = require(path.join(repo, "help"));

const OLD_TX_CARD = "PATV administrators, and a pad's owner in their own pad, can reveal the words.";
const NEW_TX_CARD = "PATV administrators and staff, the pad's owner (in their own pad) and the room's moderators can reveal the words, each time with a reason.";

test("/help: the transcripts card, its kept note and a Pepe's v2tx card name staff and mods only while text reveal roles are on", () => {
  const plain = [{ id: "transcripts", summary: "off", details: "Pepe's own words." }];
  const v2tx = [{ id: "transcripts", summary: "s", details: "d", v2tx: { details: "Bar. " + OLD_TX_CARD + " Every reveal is logged." },
                  pc: { textreveal: { swap: [[OLD_TX_CARD, NEW_TX_CARD]] } } }];
  Object.assign(SW, { tx: true, kept: false, tr: false });
  const off1 = H.withPrivwireNotes(plain)[0].details, off2 = H.withPrivwireNotes(v2tx)[0].details;
  assert.ok(off1.includes(OLD_TX_CARD) && !off1.includes("staff"), "off: the site's own card as 1.99aht says it - " + off1);
  assert.equal(off2, "Bar. " + OLD_TX_CARD + " Every reveal is logged.", "off: Pepe's v2tx words as he sent them");
  assert.equal(H.withPrivacyCopy(H.withPrivwireNotes(v2tx))[0].details, off2, "off: no pc slice applies");
  SW.tr = true;
  const on1 = H.withPrivwireNotes(plain)[0].details, on2 = H.withPrivwireNotes(v2tx)[0].details;
  assert.ok(on1.includes(NEW_TX_CARD) && !on1.includes(OLD_TX_CARD), "on: the site's card - " + on1);
  assert.equal(on2, "Bar. " + NEW_TX_CARD + " Every reveal is logged.", "on: Pepe's v2tx card the same");
  const both = H.withPrivacyCopy(H.withPrivwireNotes(v2tx))[0].details;
  assert.equal(both, on2, "Pepe's own pc swap on top finds nothing to do - the words once, never doubled");
  // the kept note (the bar not live any more, bars it made still kept)
  Object.assign(SW, { tx: false, kept: true, tr: false });
  const k0 = H.withPrivwireNotes(plain)[0].details;
  SW.tr = true;
  const k1 = H.withPrivwireNotes(plain)[0].details;
  assert.ok(k0.endsWith(H.TX_KEPT_NOTE), "kept, off: 1.99aht's note");
  assert.ok(k1.includes("only PATV administrators and staff, the pad's owner (in their own pad) and the room's moderators can reveal what you said, each time with a reason, and every reveal is logged."), k1);
  for (const [a] of H.TX_TR_SWAPS) assert.ok((H.PRIVWIRE_TX_CARDS.transcripts.details + H.TX_KEPT_NOTE).includes(a), "each swap's old text is in 1.99aht's words: " + a);
  Object.assign(SW, { tx: true, kept: false, tr: false });
});

test("/privacy: the transcripts bar's sentences name staff and mods only while text reveal roles are on; off = the page without them", () => {
  const ejs = require("ejs");
  const fn = path.join(repo, "views", "privacy.ejs");
  const src = fs.readFileSync(fn, "utf8");
  const L0 = { user: null, title: "Privacy", VERSION: "x", UPDATED: "1 January 2026", enforced: false, privwire: { g: 1, g_day: "1 January 2026" },
               chatlog: { notice_at: 1, notice_day: "1 January 2026", start_day: "1 January 2026" }, policyDates: {}, can: () => false };
  const TR = { textreveal: { on: true, on_at: 2, on_day: "3 November 2026" } };
  const OLD = {
    live: ["Administrators and the pad's owner can reveal the words, and every reveal is logged.",
           "Only the pad's owner and PATV administrators can reveal the words, and each reveal is logged.",
           "Only PATV administrators and a pad's owner (in their own pad, for lines said while they own it) can reveal the words, and every reveal is logged."],
    kept: ["and administrators and the pad's owner can reveal those too.",
           "and only the pad's owner and PATV administrators can reveal what you said.",
           "only PATV administrators and a pad's owner (in their own pad, for lines said while they own it) can reveal what you said, and every reveal is logged."],
  };
  const NEW = {
    live: ["PATV administrators and staff, the pad's owner and the room's moderators can reveal the words, each time with a reason, and every reveal is logged.",
           "Only PATV administrators and staff, the pad's owner and its room's moderators can reveal the words - each time with a reason - and each reveal is logged.",
           "Only PATV administrators and staff, a pad's owner (in their own pad, for lines said while they own it) and a room's moderators (in their own pad) can reveal the words - each time with a reason - and every reveal is logged."],
    kept: ["and PATV administrators and staff, the pad's owner and the room's moderators can reveal those too, each time with a reason.",
           "and only PATV administrators and staff, the pad's owner and its room's moderators can reveal what you said, each time with a reason.",
           "only PATV administrators and staff, a pad's owner (in their own pad, for lines said while they own it) and a room's moderators (in their own pad) can reveal what you said - each time with a reason - and every reveal is logged."],
  };
  for (const [mode, txbar] of [["live", { on: true }], ["kept", { kept: true, off_at: 1, off_day: "2 November 2026" }]]) {
    const off = ejs.render(src, Object.assign({}, L0, { txbar }), { filename: fn });
    const off2 = ejs.render(src, Object.assign({}, L0, { txbar, textreveal: null }), { filename: fn });
    assert.equal(off, off2, `${mode}, off: byte for byte the page without the switch`);
    for (const s of OLD[mode]) assert.equal(off.split(s).length, 2, `${mode}, off: 1.99aht's sentence once - ${s.slice(0, 70)}`);
    const on = ejs.render(src, Object.assign({}, L0, { txbar }, TR), { filename: fn });
    for (const s of NEW[mode]) assert.equal(on.split(s).length, 2, `${mode}, on: ${s.slice(0, 70)}`);
    for (const s of OLD[mode]) assert.equal(on.includes(s), false, `${mode}, on: the old sentence is gone - ${s.slice(0, 70)}`);
  }
  // no transcripts bar: none of it shows, switch or not
  const none = ejs.render(src, Object.assign({}, L0, TR), { filename: fn });
  for (const s of [...NEW.live, ...NEW.kept]) assert.equal(none.includes(s), false, "no bar: " + s.slice(0, 60));
});

test("reveals: a room moderator reveals a transcripts bar - tx_line under their role (and chat_line for a frog-named one), logged first", async () => {
  const ST = require(path.join(repo, "seethrough"));
  const { getQuery } = require(path.join(repo, "dbUtils"));
  await ST.init();
  const t = Date.now();
  const rows = {
    1: { ts: t - 5000, vz: { login: "tina", kind: "incognito" }, tx: true },                       // a bar (transcripts off), named
    2: { ts: t - 4000, vz: { login: "hank", kind: "hidden" }, vw: "hello", tx: true, idv: true },    // a bar with a frog name too
    3: { ts: t - 3000, vz: { login: "fred", kind: "incognito" } },                                 // a frog-named line
  };
  for (const role of [{ role: "mod", since: 0 }, { role: "staff", since: 0 }]) {
    const id0 = (await getQuery("SELECT COALESCE(MAX(id), 0) AS m FROM seethrough_log"))[0].m;
    const r = await ST.revealChat({ user: { userId: "id-" + role.role, username: role.role }, role, roomId: "Land.Room", cs: [1, 2, 3], reason: "case 9",
                                    lookup: async (c) => rows[c] || null });
    assert.deepEqual(r.refused, [], role.role + ": every era (their pad)");
    assert.deepEqual(r.items.map((o) => o.login).sort(), ["fred", "hank", "tina"]);
    const got = await getQuery("SELECT role, scope, logins, reason FROM seethrough_log WHERE id > ? ORDER BY id", [id0]);
    assert.deepEqual(got.map((x) => [x.role, x.scope, JSON.parse(x.logins).sort(), x.reason]),
                     [[role.role, "chat_line", ["fred", "hank"], "case 9"], [role.role, "tx_line", ["hank", "tina"], "case 9"]], JSON.stringify(got));
    assert.equal(r.items.find((o) => o.login === "hank").words, "hello", "a hidden bar's words");
    assert.equal(r.items.find((o) => o.account), undefined, "no account links for a non-admin");
  }
  assert.equal(ST.mayReveal({ role: "owner", since: t - 3500 }, t - 4000), false, "an owner keeps their era");
});
