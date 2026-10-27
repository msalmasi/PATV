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
  assert.equal((await FN.sight("Pad.N", "bx", { t: t + 30 * 60e3 })).alias, null, "the same alias-less session goes on");
  await FN.left("Pad.N", "bx", t + 31 * 60e3);
  const s2 = await FN.sight("Pad.N", "bx", { t: t + 95 * 60e3, active: true });
  assert.match(String(s2.alias), /^[A-Z]/, "the next appearance (1 h+ away) gets a name");
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
