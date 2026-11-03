// 1.99afn: frognames.js - the shared frog-name generator (incognito spec section C, follow-ups FU-3; owner J-8 / D-12 / D-16).
//   (a) boards: one name per person per room per day (10:00 UTC), deterministic, no word twice on a page, never a page's own
//       names, the deny lists, the fallback; the key (ALIAS_SECRET: missing / invalid -> a random key, said once).
//   (b) chat sessions: a name per person per pad per appearance - kept across a short absence, new after 1 h+ away (left and came
//       back), when the veil goes off, at 12 h + a 10-minute pause or 24 h (never during a mic hold); no name right after being
//       seen named (C.2); distinct words and hoods in a pad; not reused there for 24 h; restart-stable; no login in the table.
//   node --test test/frognames.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "frognames-test-")));
const KEY = "a1".repeat(32);
process.env.ALIAS_SECRET = KEY;
const { getQuery } = require(path.join(repo, "dbUtils"));
const FN = require(path.join(repo, "frognames"));

const keys = (n, p = "k") => Array.from({ length: n }, (_, i) => (p + String(i).padStart(4, "0")).padEnd(20, "0"));
const BANNED = ["pepe", "admin", "mod", "staff", "owner", "host", "official", "patv", "bot", "camfrog", "someone", "anonymous", "incognito", "hidden",
                "ghost", "on-air", "off-air", "lurker", "slimy", "warty", "creepy", "stinky", "ugly", "fat", "dumb", "shady", "toxic", "horny", "kermit"];

test("the word lists: 64 adjectives x 44 nouns, all different, 2,755 pairs of 20 characters or fewer, no banned word anywhere", () => {
  assert.equal(FN.ADJ.length, 64);
  assert.equal(FN.NOUN.length, 44);
  assert.equal(new Set(FN.ADJ).size, 64);
  assert.equal(new Set(FN.NOUN).size, 44);
  let fit = 0;
  for (const a of FN.ADJ) for (const n of FN.NOUN) if ((a + " " + n).length <= FN.NAME_MAX) fit++;
  assert.equal(fit, 2755);
  for (const w of [...FN.ADJ, ...FN.NOUN]) {
    const low = w.toLowerCase();
    for (const b of BANNED) assert.ok(b.length <= 3 ? !low.split("-").includes(b) : !low.includes(b), `${w} holds "${b}"`);
  }
  assert.equal(FN.denied("Ghost Frog"), true);
  assert.equal(FN.denied("Static Bot"), true, "a short word as a whole word");
  assert.equal(FN.denied("Sneaky Peeper"), true, "a deny pair");
  assert.equal(FN.denied("Soggy Bullfrog"), false);
  assert.equal(FN.denied("Bogtrotter Kermit"), true);
});

test("boards: deterministic per (room, day), no adjective or noun twice on a page, <= 20 characters, nothing banned, never a page's own names", () => {
  const ks = keys(12);
  const p = FN.boardPeriod(Date.UTC(2026, 9, 27, 12));
  const a = FN.boardAliases("You_Were_Never_Here", p, ks);
  const b = FN.boardAliases("You_Were_Never_Here", p, [...ks].reverse());
  assert.deepEqual([...ks].map((k) => a.get(k)), [...ks].map((k) => b.get(k)), "the same names whatever order the page lists them in");
  const names = [...a.values()];
  assert.equal(new Set(names.map((n) => n.split(" ")[0])).size, 12, "no adjective twice");
  assert.equal(new Set(names.map((n) => n.split(" ")[1])).size, 12, "no noun twice (so no pair twice)");
  for (const n of names) {
    assert.ok(n.length <= 20, n);
    assert.ok(FN.ADJ.includes(n.split(" ")[0]) && FN.NOUN.includes(n.split(" ")[1]), n);
    assert.equal(FN.denied(n), false, n);
  }
  // a name that reads like a login / display name the page shows is skipped ("Soggy-Toad" = "soggy toad")
  const first = a.get(ks[0]);
  const c = FN.boardAliases("You_Were_Never_Here", p, ks, [first.replace(" ", "-").toUpperCase(), "someone else"]);
  assert.notEqual(c.get(ks[0]), first);
  assert.ok(![...c.values()].includes(first));
  // a repeat key is one person
  assert.equal(FN.boardAliases("R", p, ["x".repeat(20), "x".repeat(20)]).size, 1);
});

test("boards: the name turns over at 10:00 UTC (stable before it), and another room gives unrelated names", () => {
  const ks = keys(6);
  const at = (h, m = 0, d = 27) => FN.boardPeriod(Date.UTC(2026, 9, d, h, m));
  assert.equal(at(10, 0), at(23, 59));
  assert.equal(at(10, 0), at(9, 59, 28), "the day runs 10:00 to 09:59 UTC");
  assert.equal(at(9, 59) + 1, at(10, 0));
  assert.equal(FN.boardPeriodEnds(Date.UTC(2026, 9, 27, 12)), Date.UTC(2026, 9, 28, 10));
  const day1 = FN.boardAliases("Pad.A", at(11), ks), day1b = FN.boardAliases("Pad.A", at(9, 30, 28), ks), day2 = FN.boardAliases("Pad.A", at(10, 0, 28), ks);
  assert.deepEqual([...day1.values()], [...day1b.values()], "stable within the day");
  assert.ok(ks.filter((k) => day1.get(k) !== day2.get(k)).length >= 5, "new names the next day");
  const other = FN.boardAliases("Pad.B", at(11), ks);
  assert.ok(ks.filter((k) => day1.get(k) !== other.get(k)).length >= 5, "unrelated in another room");
});

test("boards: past the words (45+ people on one page) the rest are 'Mystery Frog N', the lowest free N", () => {
  const m = FN.boardAliases("Big", 1, keys(50));
  const names = [...m.values()];
  assert.equal(new Set(names).size, 50);
  const myst = names.filter((n) => /^Mystery Frog \d+$/.test(n)).sort((x, y) => Number(x.split(" ")[2]) - Number(y.split(" ")[2]));
  assert.ok(myst.length >= 6, myst.length);
  assert.deepEqual(myst, myst.map((_, i) => "Mystery Frog " + (i + 1)));
});

test("the key: ALIAS_SECRET (hex / base64) is used as is; missing or unreadable -> a random key for this process, said ONCE, flagged", () => {
  const ks = keys(3);
  FN._reset();
  const withKey = [...FN.boardAliases("R", 1, ks).values()];
  assert.equal(FN.secretState(), "set");
  FN._reset();
  assert.deepEqual([...FN.boardAliases("R", 1, ks).values()], withKey, "the same key -> the same names after a restart");
  process.env.ALIAS_SECRET = Buffer.from(KEY, "hex").toString("base64");
  FN._reset();
  assert.deepEqual([...FN.boardAliases("R", 1, ks).values()], withKey, "base64 of the same 32 bytes is the same key");
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try {
    for (const [v, state] of [[undefined, "missing"], ["", "missing"], ["short", "invalid"], ["not hex, not base64!".repeat(4), "invalid"]]) {
      if (v === undefined) delete process.env.ALIAS_SECRET; else process.env.ALIAS_SECRET = v;
      FN._reset();
      errs.length = 0;
      const r1 = [...FN.boardAliases("R", 1, ks).values()];
      FN.boardAliases("R", 2, ks);
      assert.equal(FN.secretState(), state, String(v));
      assert.equal(errs.length, 1, "said once: " + JSON.stringify(errs));
      assert.match(errs[0], /ALIAS_SECRET is (missing|invalid)/);
      assert.ok(!errs[0].includes(String(v || "~~")) || !v, "the value itself is never printed");
      assert.notDeepEqual(r1, withKey, "a random key: other names");
    }
  } finally { console.error = realErr; process.env.ALIAS_SECRET = KEY; FN._reset(); }
});

test("sessions (b): a name per person per pad; kept across a short absence; NEW after 1 h+ away (owner J-8), when the veil goes off, at 12 h + 10 quiet minutes, or 24 h - never during a mic hold", async () => {
  let t = Date.UTC(2026, 9, 27, 12);
  FN._setClock(() => t);
  const s1 = await FN.sight("Pad.A", "Frankie", { t, active: true });
  assert.match(s1.alias, /^[A-Z][A-Za-z-]+ [A-Z][a-z]+$/);
  assert.ok(s1.hood >= 0 && s1.hood < 8);
  assert.deepEqual(await FN.sight("Pad.A", "frankie", { t: t + 60e3 }), s1, "the same session (logins compare lower case)");
  await FN.left("Pad.A", "frankie", t + 120e3);
  t += 120e3 + 59 * 60e3;
  assert.equal((await FN.sight("Pad.A", "frankie", { t })).alias, s1.alias, "back after 59 minutes: the same name");
  await FN.left("Pad.A", "frankie", t);
  t += 61 * 60e3;
  const s2 = await FN.sight("Pad.A", "frankie", { t, active: true });
  assert.notEqual(s2.session, s1.session, "back after 61 minutes: a new session");
  assert.notEqual(s2.alias, s1.alias, "...and a new name (never the last 24 h's in this pad)");
  // the veil goes off: their sessions end everywhere; the next sighting is a new one
  await FN.sight("Pad.B", "frankie", { t });
  assert.equal(await FN.off("frankie", null, t + 1), 2);
  assert.equal(FN.current("Pad.A", "frankie"), null);
  const s3 = await FN.sight("Pad.A", "frankie", { t: t + 2, active: true });
  assert.notEqual(s3.session, s2.session);
  // 12 h: kept while they keep talking, rotated at the first 10-minute pause - and never mid-hold
  t = t + 2;
  for (let i = 1; i <= 13 * 12; i++) assert.equal((await FN.sight("Pad.A", "frankie", { t: t + i * 5 * 60e3, active: true })).session, s3.session, "talking every 5 minutes: kept (" + i * 5 + " min)");
  const tHold = t + 13 * 3600e3 + 11 * 60e3;
  assert.equal((await FN.sight("Pad.A", "frankie", { t: t + 13 * 3600e3, active: true, holding: true })).session, s3.session, "a hold starts");
  assert.equal((await FN.sight("Pad.A", "frankie", { t: tHold })).session, s3.session, "12 h + a pause, but mid-hold: kept");
  assert.equal((await FN.sight("Pad.A", "frankie", { t: t + 25 * 3600e3 })).session, s3.session, "24 h, still mid-hold: kept");
  const s4 = await FN.sight("Pad.A", "frankie", { t: t + 25 * 3600e3 + 1, holding: false });
  assert.equal(s4.session, s3.session, "(the release itself keeps it)");
  const s5 = await FN.sight("Pad.A", "frankie", { t: t + 25 * 3600e3 + 2, active: true });
  assert.notEqual(s5.session, s3.session, "after the hold: the 24 h cap ends it");
  // the 12 h + pause rule on its own
  const u0 = t + 30 * 3600e3;
  const q1 = await FN.sight("Pad.Q", "quiet1", { t: u0, active: true });
  assert.equal((await FN.sight("Pad.Q", "quiet1", { t: u0 + 12 * 3600e3 - 60e3, active: true })).session, q1.session, "under 12 h: kept");
  assert.equal((await FN.sight("Pad.Q", "quiet1", { t: u0 + 12 * 3600e3 + 8 * 60e3, active: false })).session, q1.session, "12 h, quiet only 9 minutes: kept");
  assert.notEqual((await FN.sight("Pad.Q", "quiet1", { t: u0 + 12 * 3600e3 + 10 * 60e3, active: true })).session, q1.session, "12 h + 11 quiet minutes: new");
  FN._setClock(null);
});

test("sessions: no name right after being seen NAMED in the pad (C.2), a name at the next fresh appearance; different people differ in words and hood", async () => {
  const t = Date.UTC(2026, 10, 1, 12);
  FN.named("Pad.N", "bx", t);
  const s = await FN.sight("Pad.N", "bx", { t: t + 5 * 60e3, active: true });
  assert.equal(s.alias, null, "5 minutes after a named line: no frog name (someone)");
  assert.equal(s.hood, null);
  assert.equal((await FN.sight("Pad.N", "bx", { t: t + 14 * 60e3 })).session, s.session, "the same alias-less session goes on (14 minutes)");
  // 1.99?? (owner 2026-11-03): once 15 minutes have passed since the named sighting, the next sighting gets a frog name - mid-visit
  const s1 = await FN.sight("Pad.N", "bx", { t: t + 30 * 60e3 });
  assert.match(String(s1.alias), /^[A-Z]/, "30 minutes after the named line, still in the room: a frog name");
  assert.notEqual(s1.session, s.session);
  await FN.left("Pad.N", "bx", t + 31 * 60e3);
  const s2 = await FN.sight("Pad.N", "bx", { t: t + 95 * 60e3, active: true });
  assert.match(String(s2.alias), /^[A-Z]/, "the next appearance (1 h+ away) gets a name");
  assert.notEqual(s2.alias, s1.alias, "(a new one: never the last 24 h's in this pad)");
  FN.named("Pad.N", "other", t);
  assert.match(String((await FN.sight("Pad.N", "other", { t: t + 16 * 60e3 })).alias), /^[A-Z]/, "16 minutes after: a name");
  // eight people in one pad: no shared adjective, noun or hood
  const v = [];
  for (let i = 0; i < 8; i++) v.push(await FN.sight("Pad.Crowd", "p" + i, { t, avoidNames: ["Soggy Bullfrog"] }));
  assert.equal(new Set(v.map((x) => x.alias.split(" ")[0])).size, 8);
  assert.equal(new Set(v.map((x) => x.alias.split(" ")[1])).size, 8);
  assert.equal(new Set(v.map((x) => x.hood)).size, 8, "8 hoods for 8 people");
  assert.ok(!v.some((x) => x.alias === "Soggy Bullfrog"), "never someone's name in the roster");
  assert.equal(FN.namesInUse("Pad.Crowd", t).size, 8);
  // the same person in two pads: two unrelated sessions
  const a = await FN.sight("Pad.X", "same", { t }), b = await FN.sight("Pad.Y", "same", { t });
  assert.notEqual(a.session, b.session);
});

test("sessions: never the same name in a pad within 24 h; restart-stable; the table never holds a login, and an ended row loses its keys and goes after 24 h", async () => {
  const t = Date.UTC(2026, 10, 3, 12);
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const s = await FN.sight("Pad.R", "again", { t: t + i * 1000 });
    assert.ok(!seen.has(s.alias), "repeated: " + s.alias);
    seen.add(s.alias);
    await FN.off("again", "Pad.R", t + i * 1000 + 1);
  }
  const keep = await FN.sight("Pad.R", "stays", { t });
  FN._reset();                                                       // a site restart (same ALIAS_SECRET)
  FN._setClock(() => t + 5000);
  assert.deepEqual(FN.current("Pad.R", "stays"), null, "(memory empty until loaded)");
  assert.deepEqual(await FN.sight("Pad.R", "stays", { t: t + 5000 }), keep, "reloaded from incog_alias: the same session and name");
  const rows = await getQuery("SELECT * FROM incog_alias");
  const dump = JSON.stringify(rows);
  for (const l of ["again", "stays", "frankie", "Frankie"]) assert.ok(!dump.includes('"' + l + '"'), "no login in incog_alias: " + l);
  const ended = rows.filter((r) => r.ended != null);
  assert.ok(ended.length >= 12 && ended.every((r) => r.sk == null && r.nonce == null), "an ended session keeps no key");
  const n = await FN.sweep(t + 25 * 3600e3);
  assert.ok(n >= 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM incog_alias WHERE ended IS NOT NULL AND ended < ?", [t + 3600e3]))[0].n, 0, "ended 24 h ago: deleted");
  FN._setClock(null);
});

test("privacy fix (M addendum 3 #1): incognito -> hidden ends the session AT ONCE (even mid-hold) and the next one is alias-less; hidden -> incognito keeps it; the level survives a restart", async () => {
  const t = Date.UTC(2026, 10, 4, 12);
  const a = await FN.sight("Pad.L", "bouncy", { t, active: true, kind: "incognito" });
  assert.match(String(a.alias), /^[A-Z]/, "a frog name while incognito");
  assert.equal((await FN.sight("Pad.L", "bouncy", { t: t + 1000, active: true, kind: "incognito" })).session, a.session, "kept while incognito");
  await FN.sight("Pad.L", "bouncy", { t: t + 2000, active: true, holding: true, kind: "incognito" });
  const b = await FN.sight("Pad.L", "bouncy", { t: t + 3000, active: true, kind: "hidden" });
  assert.notEqual(b.session, a.session, "the switch to hidden ends it at once - mid-hold too");
  assert.equal(b.alias, null, "the next session has no frog name (masked, 'someone') - never the incognito one");
  assert.equal(b.hood, null);
  assert.equal((await FN.sight("Pad.L", "bouncy", { t: t + 4000, kind: "incognito" })).session, b.session, "hidden -> incognito keeps the session");
  const b2 = await FN.sight("Pad.L", "bouncy", { t: t + 5000, kind: "hidden" });
  assert.ok(b2.session !== b.session && b2.alias === null, "...and incognito -> hidden again ends it again (alias-less)");
  // a hidden session from the start keeps its name through more hidden sightings, and through a restart (the level is stored)
  const h = await FN.sight("Pad.L", "shadowy", { t, kind: "hidden" });
  assert.match(String(h.alias), /^[A-Z]/);
  assert.equal((await FN.sight("Pad.L", "shadowy", { t: t + 60e3, kind: "hidden" })).session, h.session);
  const i = await FN.sight("Pad.L", "peeky", { t, kind: "incognito" });
  FN._reset();
  FN._setClock(() => t + 120e3);
  assert.equal((await FN.sight("Pad.L", "shadowy", { t: t + 120e3, kind: "hidden" })).alias, h.alias, "after a restart a hidden session keeps its name");
  const i2 = await FN.sight("Pad.L", "peeky", { t: t + 121e3, kind: "hidden" });
  assert.notEqual(i2.session, i.session, "after a restart an incognito session still ends on the switch to hidden");
  assert.equal(i2.alias, null, "...alias-less");
  // a session of unknown level (no kind given) sighted hidden: ends (fails closed) with a NEW name, never the old one
  const u = await FN.sight("Pad.L", "oldrow", { t: t + 130e3 });
  const u2 = await FN.sight("Pad.L", "oldrow", { t: t + 131e3, kind: "hidden" });
  assert.notEqual(u2.session, u.session);
  assert.notEqual(u2.alias, u.alias);
  // level(): Pepe's privacy.hidden / a hidden leave, without a sighting
  const p = await FN.sight("Pad.L", "evented", { t: t + 140e3, kind: "incognito" });
  assert.equal(await FN.level("Pad.L", "evented", "incognito", t + 141e3), false, "incognito again: nothing ends");
  assert.equal(await FN.level("Pad.L", "evented", "hidden", t + 142e3), true, "hidden: the session ends");
  assert.equal(FN.current("Pad.L", "evented"), null);
  assert.equal((await FN.sight("Pad.L", "evented", { t: t + 143e3, kind: "hidden" })).alias, null, "the next one is alias-less");
  assert.ok(p.session);
  const q = await FN.sight("Pad.L", "unknownlvl", { t: t + 150e3 });
  assert.equal(await FN.level("Pad.L", "unknownlvl", "hidden", t + 151e3, { wasIncognito: true }), true);
  assert.equal((await FN.sight("Pad.L", "unknownlvl", { t: t + 152e3, kind: "hidden" })).alias, null, "wasIncognito: alias-less even at an unknown level");
  assert.ok(q.session);
  const hh = await FN.sight("Pad.L", "stayhidden", { t: t + 160e3, kind: "hidden" });
  assert.equal(await FN.level("Pad.L", "stayhidden", "hidden", t + 161e3), false, "a hidden session isn't ended by 'hidden'");
  assert.equal(FN.current("Pad.L", "stayhidden").session, hh.session);
  const rows = await getQuery("SELECT lvl FROM incog_alias WHERE ended IS NULL AND lvl IS NOT NULL");
  assert.ok(rows.length >= 1 && rows.every((r) => r.lvl === "incognito" || r.lvl === "hidden"), "the level column holds only the two levels");
  FN._setClock(null);
});

test("privacy fix (review F7): the switch's 15-minute no-name window survives a site restart on the level() paths (Pepe's privacy.hidden, a hidden leave)", async () => {
  const t = Date.UTC(2026, 10, 5, 12);
  FN._setClock(() => t);
  // level(): the person isn't sighted at the switch (privacy.hidden while off the roster, a hidden leave) - no alias-less row is left
  const a = await FN.sight("Pad.R", "restarty", { t, active: true, kind: "incognito" });
  assert.match(String(a.alias), /^[A-Z]/, "a frog name while incognito");
  assert.equal(await FN.level("Pad.R", "restarty", "hidden", t + 1000, { wasIncognito: true }), true, "the switch ends the session");
  FN._reset();                                                         // a site restart (same DB, same ALIAS_SECRET)
  FN._setClock(() => t + 120e3);
  const b = await FN.sight("Pad.R", "restarty", { t: t + 120e3, kind: "hidden" });
  assert.equal(b.alias, null, "2 minutes after the switch, after a restart: still no frog name (a fresh one would be tied to the old by timing)");
  assert.notEqual(b.session, a.session);
  // the same through the hidden-leave shape: level() on an incognito session (no wasIncognito needed)
  const c = await FN.sight("Pad.R", "leavey", { t: t + 130e3, active: true, kind: "incognito" });
  assert.ok(c.alias);
  assert.equal(await FN.level("Pad.R", "leavey", "hidden", t + 131e3), true);
  await FN.left("Pad.R", "leavey", t + 131e3);
  FN._reset();
  FN._setClock(() => t + 300e3);
  assert.equal((await FN.sight("Pad.R", "leavey", { t: t + 300e3, kind: "hidden" })).alias, null, "a hidden leave's window survives a restart too");
  // the window is 15 minutes: once over (and after another restart) the next session gets a name again
  FN._reset();
  FN._setClock(() => t + 20 * 60e3);
  await FN.off("restarty", "Pad.R", t + 20 * 60e3);                   // (end the alias-less one)
  const d = await FN.sight("Pad.R", "restarty", { t: t + 20 * 60e3 + 1000, kind: "hidden" });
  assert.match(String(d.alias), /^[A-Z]/, "after the 15 minutes a new session has a frog name");
  // the stored window holds no login, no name, no session id - and goes once it is over
  const cols = (await getQuery("SELECT name FROM pragma_table_info('incog_alias_burn')")).map((r) => r.name).sort();
  assert.deepEqual(cols, ["at", "room_id", "sk"]);
  const rows = await getQuery("SELECT * FROM incog_alias_burn");
  assert.ok(!JSON.stringify(rows).includes("restarty") && !JSON.stringify(rows).includes("leavey"), "no login in the table");
  assert.ok(rows.every((r) => Number(r.at) % 60e3 === 0), "the time is rounded to the minute (not joinable to the ended row's exact end)");
  await FN.sweep(t + 40 * 60e3);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM incog_alias_burn WHERE at <= ?", [t + 40 * 60e3 - FN.NAMED_GAP_MS]))[0].n, 0, "swept once over");
  FN._setClock(null);
});

test("review R1: a FROZEN kind (a mic hold's, as it was when the hold began) never ends a session on level nor changes its level; it only gives a new session its level", async () => {
  const t = Date.UTC(2026, 10, 6, 12);
  const a = await FN.sight("Pad.Z", "frozeny", { t, active: true, kind: "incognito" });
  assert.ok(a.alias);
  const b = await FN.sight("Pad.Z", "frozeny", { t: t + 1000, kind: "hidden", frozen: true });
  assert.equal(b.session, a.session, "a frozen 'hidden' on an incognito session: kept");
  assert.equal(b.alias, a.alias);
  assert.equal((await getQuery("SELECT lvl FROM incog_alias WHERE id = ?", [a.session]))[0].lvl, "incognito", "its level unchanged");
  const c = await FN.sight("Pad.Z", "frozeny", { t: t + 2000, kind: "hidden" });
  assert.ok(c.session !== a.session && c.alias === null, "a person-level 'hidden' still ends it at once (alias-less next)");
  const d = await FN.sight("Pad.Z", "newfrozen", { t: t + 3000, kind: "hidden", frozen: true });
  assert.equal((await getQuery("SELECT lvl FROM incog_alias WHERE id = ?", [d.session]))[0].lvl, "hidden", "a session a frozen sighting opens gets that level");
});

// ── 1.99?? (owner 2026-11-03, "Lets do 2"): "someone" only for 15 minutes after the last named sighting, then a frog name - even mid-visit ──
const MIN = 60e3;
const ALIAS_RE = /^(?:[A-Z][A-Za-z-]+ [A-Z][A-Za-z]+|Mystery Frog \d+)$/;

test("1.99?? cyberbaby2: seen named, incognito on in the room - 'someone' at +5 and +14 minutes, a frog name at +16 (a fresh session under every name rule)", async () => {
  const t = Date.UTC(2026, 10, 7, 12);
  const ends = [];
  const unsub = FN.onEnd((e) => ends.push(e));
  // the pad: 6 incognito people with frog names, one name used here earlier today, a roster of named people
  const others = [];
  for (let i = 0; i < 6; i++) others.push(await FN.sight("Pad.CB", "crowd" + i, { t, kind: "incognito" }));
  const gone = await FN.sight("Pad.CB", "goneearlier", { t, kind: "incognito" });
  await FN.off("goneearlier", "Pad.CB", t + 1000);
  const roster = ["Soggy Bullfrog", "Pixel Toad", "alicecf", "Alice"];
  FN.named("Pad.CB", "cyberbaby2", t);
  const a = await FN.sight("Pad.CB", "cyberbaby2", { t: t + 5 * MIN, active: true, kind: "incognito", avoidNames: roster });
  assert.equal(a.alias, null, "+5 min: someone");
  assert.equal(a.hood, null);
  const b = await FN.sight("Pad.CB", "cyberbaby2", { t: t + 14 * MIN, active: true, kind: "incognito", avoidNames: roster });
  assert.equal(b.session, a.session, "+14 min: the same session");
  assert.equal(b.alias, null, "+14 min: still someone");
  const rowA = (await getQuery("SELECT * FROM incog_alias WHERE id = ?", [a.session]))[0];
  assert.equal(Number(rowA.named_at), t, "the no-name window's anchor is on the open row");
  const c = await FN.sight("Pad.CB", "cyberbaby2", { t: t + 16 * MIN, active: true, kind: "incognito", avoidNames: roster });
  assert.match(String(c.alias), ALIAS_RE, "+16 min: a frog name");
  assert.notEqual(c.session, a.session, "a new session (a new nonce: unlinkable to the no-name one by the key)");
  assert.ok(Number.isInteger(c.hood) && c.hood >= 0 && c.hood < 8);
  // every name rule: no word or hood shared with the open sessions, never a roster name, not the pad's last 24 h's, nothing denied
  const [adj, noun] = c.alias.split(" ");
  for (const o of others) {
    assert.ok(!o.alias.split(" ").includes(adj) && !o.alias.split(" ").includes(noun), c.alias + " shares a word with " + o.alias);
    assert.notEqual(o.hood, c.hood, "a hood nobody open has (7 people, 8 hoods)");
  }
  assert.notEqual(c.alias, gone.alias, "never a name used in this pad in the last 24 h");
  assert.ok(!roster.map(FN.norm).includes(FN.norm(c.alias)), "never a roster name");
  assert.equal(FN.denied(c.alias), false);
  assert.deepEqual(ends.filter((e) => e.session === a.session).map((e) => e.why), ["gap"], "the no-name session ended (covers come off)");
  // the ended row keeps no key and no window; the new one is an ordinary named row at the same level
  const rowOld = (await getQuery("SELECT * FROM incog_alias WHERE id = ?", [a.session]))[0];
  assert.ok(rowOld.sk == null && rowOld.nonce == null && rowOld.named_at == null && Number(rowOld.ended) === t + 16 * MIN);
  const rowNew = (await getQuery("SELECT * FROM incog_alias WHERE id = ?", [c.session]))[0];
  assert.ok(rowNew.named_at == null && rowNew.nonce != null && rowNew.lvl === "incognito" && rowNew.name === c.alias);
  assert.ok(!JSON.stringify([rowOld, rowNew]).includes("cyberbaby2"), "no login in the table");
  assert.deepEqual(await FN.sight("Pad.CB", "cyberbaby2", { t: t + 17 * MIN, kind: "incognito" }), c, "the frog name is kept from then on");
  unsub();
});

test("1.99?? a mic hold across the 15-minute mark: still 'someone' while held and at the release - the name comes at the next sighting", async () => {
  const t = Date.UTC(2026, 10, 8, 12);
  FN.named("Pad.MH", "holdy", t);
  const a = await FN.sight("Pad.MH", "holdy", { t: t + 5 * MIN, kind: "incognito" });
  assert.equal(a.alias, null);
  assert.equal((await FN.sight("Pad.MH", "holdy", { t: t + 10 * MIN, active: true, holding: true, kind: "incognito" })).session, a.session, "the grab");
  for (const m of [16, 20, 25]) {
    const v = await FN.sight("Pad.MH", "holdy", { t: t + m * MIN, kind: "incognito" });
    assert.ok(v.session === a.session && v.alias === null, "+" + m + " min, mid-hold: still someone");
  }
  const rel = await FN.sight("Pad.MH", "holdy", { t: t + 26 * MIN, active: true, holding: false, kind: "incognito" });
  assert.ok(rel.session === a.session && rel.alias === null, "the release itself keeps it (like the other caps)");
  const after = await FN.sight("Pad.MH", "holdy", { t: t + 26 * MIN + 30e3, kind: "incognito" });
  assert.match(String(after.alias), ALIAS_RE, "after the release: a frog name");
  assert.notEqual(after.session, a.session);
  // a hold's frozen kind after the release opens the named session at the person's own level, not the hold's
  FN.named("Pad.MH", "frozenrel", t);
  const f = await FN.sight("Pad.MH", "frozenrel", { t: t + 5 * MIN, kind: "incognito" });
  const g = await FN.sight("Pad.MH", "frozenrel", { t: t + 20 * MIN, kind: "hidden", frozen: true });
  assert.ok(g.session !== f.session && ALIAS_RE.test(String(g.alias)));
  assert.equal((await getQuery("SELECT lvl FROM incog_alias WHERE id = ?", [g.session]))[0].lvl, "incognito", "keeps the person's level");
});

test("1.99?? seen named AGAIN restarts the 15 minutes (with or without the session ending)", async () => {
  const t = Date.UTC(2026, 10, 9, 12);
  // a named sighting while the no-name session stays open (FN.named alone): the same session, a later window
  FN.named("Pad.NA", "twice", t);
  const a = await FN.sight("Pad.NA", "twice", { t: t + 5 * MIN });
  assert.equal(a.alias, null);
  await FN.named("Pad.NA", "twice", t + 10 * MIN);
  for (const m of [16, 24]) {
    const v = await FN.sight("Pad.NA", "twice", { t: t + m * MIN });
    assert.ok(v.session === a.session && v.alias === null, "+" + m + " min (named again at +10): still someone");
  }
  assert.equal(Number((await getQuery("SELECT named_at FROM incog_alias WHERE id = ?", [a.session]))[0].named_at), t + 10 * MIN, "the stored window moved");
  const b = await FN.sight("Pad.NA", "twice", { t: t + 25 * MIN + 1000 });
  assert.match(String(b.alias), ALIAS_RE, "15 minutes after the second named sighting: a frog name");
  // the usual path (veil.namedSeen): named + their session ends; the next veiled sighting is someone again, for 15 more minutes
  FN.named("Pad.NA", "twice", t + 40 * MIN);
  await FN.off("twice", "Pad.NA", t + 40 * MIN);
  const c = await FN.sight("Pad.NA", "twice", { t: t + 45 * MIN });
  assert.ok(c.alias === null && c.session !== b.session);
  assert.equal((await FN.sight("Pad.NA", "twice", { t: t + 54 * MIN })).alias, null);
  assert.match(String((await FN.sight("Pad.NA", "twice", { t: t + 56 * MIN })).alias), ALIAS_RE);
  // an older named sighting replayed later (a restart's feed replay) never shortens the window
  FN.named("Pad.NA", "replay", t + 10 * MIN);
  FN.named("Pad.NA", "replay", t);
  assert.equal((await FN.sight("Pad.NA", "replay", { t: t + 20 * MIN })).alias, null, "the latest named sighting counts");
});

test("1.99?? incognito -> hidden still ends the frog name at once; 'someone' for 15 minutes, then a NEW frog name (sight and level paths)", async () => {
  const t = Date.UTC(2026, 10, 10, 12);
  const x = await FN.sight("Pad.IH", "switchy", { t, active: true, kind: "incognito" });
  assert.match(String(x.alias), ALIAS_RE);
  const y = await FN.sight("Pad.IH", "switchy", { t: t + MIN, kind: "hidden" });
  assert.ok(y.session !== x.session && y.alias === null, "the switch: ends at once, someone");
  assert.equal((await FN.sight("Pad.IH", "switchy", { t: t + 15 * MIN, kind: "hidden" })).session, y.session, "14 minutes after the switch: someone");
  const z = await FN.sight("Pad.IH", "switchy", { t: t + 16 * MIN + 1000, kind: "hidden" });
  assert.match(String(z.alias), ALIAS_RE, "15 minutes after the switch: a frog name");
  assert.notEqual(z.alias, x.alias, "never the incognito one again");
  assert.equal((await getQuery("SELECT lvl FROM incog_alias WHERE id = ?", [z.session]))[0].lvl, "hidden");
  // level(): Pepe's privacy.hidden without a sighting
  const p = await FN.sight("Pad.IH", "evented2", { t, kind: "incognito" });
  assert.equal(await FN.level("Pad.IH", "evented2", "hidden", t + 2 * MIN, { wasIncognito: true }), true);
  const q = await FN.sight("Pad.IH", "evented2", { t: t + 3 * MIN, kind: "hidden" });
  assert.equal(q.alias, null);
  assert.equal((await FN.sight("Pad.IH", "evented2", { t: t + 16 * MIN, kind: "hidden" })).alias, null, "14 minutes after the switch");
  const r = await FN.sight("Pad.IH", "evented2", { t: t + 17 * MIN + 1000, kind: "hidden" });
  assert.ok(ALIAS_RE.test(String(r.alias)) && r.alias !== p.alias);
});

test("1.99?? the 15 minutes survive a restart: inside the window still 'someone' (rounded up, never shorter), after it a frog name; a row from before the column counts from its start", async () => {
  const { runQuery } = require(path.join(repo, "dbUtils"));
  // inside: the named sighting at :30 s is stored rounded UP to the minute
  const t = Date.UTC(2026, 10, 11, 12) + 30e3;
  FN.named("Pad.RS", "restart1", t);
  const a = await FN.sight("Pad.RS", "restart1", { t: t + 5 * MIN });
  assert.equal(a.alias, null);
  FN._reset();
  FN._setClock(() => t + 10 * MIN);
  const b = await FN.sight("Pad.RS", "restart1", { t: t + 10 * MIN });
  assert.ok(b.session === a.session && b.alias === null, "after a restart, inside the window: the same no-name session");
  assert.equal((await FN.sight("Pad.RS", "restart1", { t: t + 15 * MIN + 10e3 })).alias, null, "rounded up: never shorter after a restart");
  assert.match(String((await FN.sight("Pad.RS", "restart1", { t: t + 16 * MIN })).alias), ALIAS_RE, "then a frog name");
  // after: a restart once the 15 minutes are over - the next sighting gets the name
  const t2 = Date.UTC(2026, 10, 11, 14);
  FN.named("Pad.RS", "restart2", t2);
  const c = await FN.sight("Pad.RS", "restart2", { t: t2 + 5 * MIN });
  assert.equal(c.alias, null);
  FN._reset();
  FN._setClock(() => t2 + 20 * MIN);
  const d = await FN.sight("Pad.RS", "restart2", { t: t2 + 21 * MIN });
  assert.ok(d.session !== c.session && ALIAS_RE.test(String(d.alias)), "after a restart past the window: a frog name");
  // a named-again window (stored by named()) survives a restart too
  const t3 = Date.UTC(2026, 10, 11, 16);
  FN.named("Pad.RS", "restart3", t3);
  const e = await FN.sight("Pad.RS", "restart3", { t: t3 + 5 * MIN });
  await FN.named("Pad.RS", "restart3", t3 + 10 * MIN);
  FN._reset();
  FN._setClock(() => t3 + 12 * MIN);
  assert.equal((await FN.sight("Pad.RS", "restart3", { t: t3 + 16 * MIN })).session, e.session, "named again at +10, restart: someone at +16");
  assert.match(String((await FN.sight("Pad.RS", "restart3", { t: t3 + 26 * MIN })).alias), ALIAS_RE);
  // the switch's burn (incognito -> hidden) through a restart: someone inside, a frog name after
  const t4 = Date.UTC(2026, 10, 11, 18);
  const f = await FN.sight("Pad.RS", "restart4", { t: t4, kind: "incognito" });
  const g = await FN.sight("Pad.RS", "restart4", { t: t4 + MIN, kind: "hidden" });
  assert.ok(f.alias && g.alias === null);
  FN._reset();
  FN._setClock(() => t4 + 10 * MIN);
  assert.equal((await FN.sight("Pad.RS", "restart4", { t: t4 + 10 * MIN, kind: "hidden" })).session, g.session);
  assert.match(String((await FN.sight("Pad.RS", "restart4", { t: t4 + 17 * MIN, kind: "hidden" })).alias), ALIAS_RE);
  // a no-name row from before named_at (the deploy): its window counts from the session's start (fails private)
  const t5 = Date.UTC(2026, 10, 11, 20);
  FN.named("Pad.RS", "oldrow2", t5);
  const h = await FN.sight("Pad.RS", "oldrow2", { t: t5 + 5 * MIN });
  await runQuery("UPDATE incog_alias SET named_at = NULL WHERE id = ?", [h.session]);
  FN._reset();
  FN._setClock(() => t5 + 6 * MIN);
  assert.equal((await FN.sight("Pad.RS", "oldrow2", { t: t5 + 16 * MIN })).alias, null, "15 minutes from its start, not from the lost named sighting");
  assert.match(String((await FN.sight("Pad.RS", "oldrow2", { t: t5 + 20 * MIN + 1000 })).alias), ALIAS_RE);
  // the stored anchors: whole minutes, no login
  const rows = await getQuery("SELECT named_at FROM incog_alias WHERE named_at IS NOT NULL");
  assert.ok(rows.every((r) => Number(r.named_at) % MIN === 0), "rounded to the minute");
  const dump = JSON.stringify(await getQuery("SELECT * FROM incog_alias"));
  for (const l of ["restart1", "restart2", "restart3", "restart4", "oldrow2"]) assert.ok(!dump.includes(l), "no login: " + l);
  FN._setClock(null);
});

// ── 1.99?? review fixes (each fails without its fix) ──
test("1.99?? review fix: the 15 minutes don't end early when NAMED is full - the no-name session's own anchor (named_at) still counts", async () => {
  FN._reset();
  const t = Date.UTC(2026, 10, 12, 12);
  FN.named("Pad.EV", "evicty", t);
  const a = await FN.sight("Pad.EV", "evicty", { t: t + 5 * MIN });
  assert.equal(a.alias, null);
  // 50,001 other named sightings push the oldest entry (theirs) out of the in-memory map
  for (let i = 0; i < 50001; i++) FN.named("Pad.EV2", "crowd" + i, t + 5 * MIN);
  const b = await FN.sight("Pad.EV", "evicty", { t: t + 6 * MIN });
  assert.ok(b.session === a.session && b.alias === null, "+6 min: still someone (was a frog name: " + b.alias + ")");
  assert.match(String((await FN.sight("Pad.EV", "evicty", { t: t + 16 * MIN })).alias), ALIAS_RE, "then a frog name, as usual");
  FN._reset();
});

test("1.99?? review fix: a frog name is never the person's OWN login (a veiled person isn't in the roster's avoid list)", async () => {
  // find a (login, nonce) whose first draw IS that login: "analoghopper" -> "Analog Hopper" style
  const crypto = require("crypto");
  const hm = (k, ...p) => { const h = crypto.createHmac("sha256", k); for (const x of p) h.update(Buffer.isBuffer(x) ? x : Buffer.from(String(x), "utf8")); return h.digest(); };
  const key = Buffer.from(KEY, "hex");
  let hit = null;
  for (let j = 0; j < 200 && !hit; j++) {
    const nonce = crypto.createHash("sha256").update("own-login-" + j).digest().subarray(0, 16);
    for (const a of FN.ADJ) {
      for (const n of FN.NOUN) {
        const login = (a + n).toLowerCase(), name = a + " " + n;
        if (name.length > FN.NAME_MAX || FN.denied(name)) continue;
        const [ca, cn] = FN.candidate(hm(key, "patv/alias/v1\0", "Pad.OWN", "\0", login, "\0", nonce), 0);
        if (ca === a && cn === n) { hit = { login, nonce, name }; break; }
      }
      if (hit) break;
    }
  }
  assert.ok(hit, "a fixed point exists");
  const orig = crypto.randomBytes;
  crypto.randomBytes = (n, ...rest) => (n === 16 && !rest.length ? Buffer.from(hit.nonce) : orig(n, ...rest));
  let s;
  try { s = await FN.sight("Pad.OWN", hit.login, { t: Date.UTC(2026, 10, 12, 14), kind: "incognito" }); } finally { crypto.randomBytes = orig; }
  assert.match(String(s.alias), ALIAS_RE);
  assert.notEqual(FN.norm(s.alias), FN.norm(hit.login), hit.login + " got " + s.alias);
});

test("1.99?? review fix: no word of a frog name is in the person's own login ('midnightrider' never draws 'Midnight ...'), nor contains it", async () => {
  const crypto = require("crypto");
  const hm = (k, ...p) => { const h = crypto.createHmac("sha256", k); for (const x of p) h.update(Buffer.isBuffer(x) ? x : Buffer.from(String(x), "utf8")); return h.digest(); };
  const key = Buffer.from(KEY, "hex");
  // a (login, nonce) whose first draw's adjective is IN the login, and one whose noun CONTAINS the (short) login
  const find = (mk, ok) => {
    for (let j = 0; j < 400; j++) {
      const nonce = crypto.createHash("sha256").update("own-word-" + j).digest().subarray(0, 16);
      for (const w of [...FN.ADJ, ...FN.NOUN]) {
        const login = mk(w);
        const [a, n] = FN.candidate(hm(key, "patv/alias/v1 ", "Pad.WORD", " ", login, " ", nonce), 0);
        const name = a + " " + n;
        if (name.length <= FN.NAME_MAX && !FN.denied(name) && ok(w, a, n)) return { login, nonce, name };
      }
    }
    return null;
  };
  const inLogin = find((w) => w.toLowerCase().replace(/[^a-z]/g, "") + "rider", (w, a) => a === w);
  const inName = find((w) => w.toLowerCase().replace(/[^a-z]/g, "").slice(0, 4), (w, a, n) => n === w && w.length > 4);
  assert.ok(inLogin && inName, "both cases exist");
  const orig = crypto.randomBytes;
  for (const [hit, i] of [[inLogin, 0], [inName, 1]]) {
    crypto.randomBytes = (n, ...rest) => (n === 16 && !rest.length ? Buffer.from(hit.nonce) : orig(n, ...rest));
    let s;
    try { s = await FN.sight("Pad.WORD", hit.login, { t: Date.UTC(2026, 10, 12, 16) + i * 1000, kind: "incognito" }); } finally { crypto.randomBytes = orig; }
    assert.match(String(s.alias), ALIAS_RE);
    const words = s.alias.split(" ").map(FN.norm), own = FN.norm(hit.login);
    assert.ok(!words.some((x) => own.includes(x) || x.includes(own)), hit.login + " got " + s.alias + " (its first draw was " + hit.name + ")");
  }
});
