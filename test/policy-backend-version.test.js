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
