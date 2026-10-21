// tools/policy-backend.js siteVersion (2026-10-21, an item owed from the staging evidence): the site's version is the release letter
// of the newest commit subject that ISN'T the i18n bot's ("i18n: translate new strings for <sha> [skip ci]" lands on top of every
// release on staging / main) - status / preflight showed "?" whenever the translations came last.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-backend-version.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const PB = require(path.join(repo, "tools", "policy-backend.js"));      // loads no database (dbUtils only once main() runs)

test("versionOf: the newest subject that isn't the i18n bot's", () => {
  const s = (sha, subject) => ({ sha, subject });
  assert.deepEqual(PB.versionOf([s("7e49016", "i18n: translate new strings for fb3cd91 [skip ci]"),
                                 s("fb3cd91", "1.99adu site: economy policy hardening (PO-0b, PO-1, PO-2)"),
                                 s("f3a020a", "Owner answers review fixes (site, 2026-10-21)")]),
                   { version: "1.99adu", version_sha: "fb3cd91", subject: "1.99adu site: economy policy hardening (PO-0b, PO-1, PO-2)" });
  assert.equal(PB.versionOf([s("a", "I18N: something"), s("b", "i18n: more"), s("c", "1.99adt site: picker")]).version, "1.99adt", "case-insensitive, several in a row");
  assert.equal(PB.versionOf([s("a", "1.99adv site: x")]).version, "1.99adv", "a release on top");
  const nv = PB.versionOf([s("a", "i18n: x"), s("b", "Merge branch 'staging'")]);
  assert.deepEqual([nv.version, nv.version_sha], [null, "b"], "the newest non-i18n subject decides, even without a letter");
  assert.deepEqual(PB.versionOf([s("a", "i18n: only")]), { version: null, version_sha: null, subject: null });
  assert.deepEqual(PB.versionOf([]), { version: null, version_sha: null, subject: null });
});

test("siteVersion in a checkout whose HEAD is the i18n bot's commit: the release under it, HEAD's sha kept", (t) => {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch (e) { t.skip("no git"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-version-"));
  fs.mkdirSync(path.join(dir, "tools"));
  fs.copyFileSync(path.join(repo, "tools", "policy-backend.js"), path.join(dir, "tools", "policy-backend.js"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "-q", "-m", "1.99adu site: the release");
  const rel = git("rev-parse", "--short", "HEAD");
  fs.writeFileSync(path.join(dir, "x.json"), "{}");
  git("add", ".");
  git("commit", "-q", "-m", "i18n: translate new strings for " + rel + " [skip ci]");
  const head = git("rev-parse", "--short", "HEAD");
  const v = require(path.join(dir, "tools", "policy-backend.js")).siteVersion();
  assert.deepEqual([v.version, v.version_sha, v.sha], ["1.99adu", rel, head]);
});

// The mutation review of PO-3: status and preflight name the release's commit next to HEAD's when the i18n bot's commit is on
// top (and only then) - a minimal gathered state, no database.
function bare(site) {
  const eng = { mode: "off", paused: 0 };
  return { site, staging: false, engines: { treasury: eng, monetary: eng, burn: eng }, missed7: [], shadow14: [], push: null, runs: [],
           backends: Object.fromEntries(["pools", "stashes", "capital", "fed", "escrow", "gangs"].map((k) => [k, { enabled: null, live: false }])),
           owners: [], rolesPending: [], claims: [], lastW: null, closedNoAccount: [], refusedWf: [], features: {}, cfg: { store: false },
           mirrorDays: [], dualChecks: [], dualDiffs: [], moving: [], failed7: [], effectsOld: { n: 0 }, turfInbox: { n: 0 },
           evidence: { from: "2026-10-21", today: "2026-10-21", days: [], mirror: {}, dual: [] } };
}
function statusLines(s) {
  const out = [];
  const log = console.log;
  console.log = (...a) => out.push(a.join(" "));
  try { PB.printStatus(s); } finally { console.log = log; }
  return out;
}
test("status + preflight: the release's sha next to HEAD's when they differ, HEAD's alone otherwise", () => {
  const split = bare({ version: "1.99adu", version_sha: "fb3cd91", sha: "7e49016" });
  assert.equal(statusLines(split)[0], "site     1.99adu at fb3cd91 (7e49016)");
  const v = PB.preflight(split).find((r) => r.check === "site version");
  assert.deepEqual([v.level, v.detail], ["PASS", "1.99adu (release fb3cd91, head 7e49016)"]);
  const same = bare({ version: "1.99adv", version_sha: "a1b2c3d", sha: "a1b2c3d" });
  assert.equal(statusLines(same)[0], "site     1.99adv (a1b2c3d)");
  assert.equal(PB.preflight(same).find((r) => r.check === "site version").detail, "1.99adv (a1b2c3d)");
  const none = bare({ version: null, version_sha: null, sha: null });
  assert.equal(statusLines(none)[0], "site     ? (no git)");
  const w = PB.preflight(none).find((r) => r.check === "site version");
  assert.deepEqual([w.level, w.detail], ["WARN", "? (no git checkout)"]);
});
