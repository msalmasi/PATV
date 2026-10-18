// 1.99acd: tools/vapid-keys.js - the operator's VAPID key-pair generator: writes a pair loadVapid() accepts, prints the public key
// and kid but never the private key, never overwrites a file or replaces existing VAPID_ lines without --force-rotate, and
// exits 2 with usage when it isn't told where to write.
//   node --test test/vapid-keys.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const TOOL = path.join(repo, "tools", "vapid-keys.js");
const C = require(path.join(repo, "webpushcrypto"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vapid-keys-test-"));
const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { cwd: tmp, encoding: "utf8" });
const envOf = (file) => {
  const o = {};
  for (const l of fs.readFileSync(file, "utf8").split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) o[m[1]] = m[2]; }
  return o;
};

test("--out writes the three lines; loadVapid accepts them; stdout has the public key + kid, never the private key", () => {
  const f = path.join(tmp, "keys.env");
  const r = run("--out", f, "--subject", "mailto:ops@example.com");
  assert.equal(r.status, 0, r.stderr);
  const env = envOf(f);
  assert.deepEqual(Object.keys(env).sort(), ["VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY", "VAPID_SUBJECT"]);
  const v = C.loadVapid(env);
  assert.equal(v.ok, true);
  assert.ok(r.stdout.includes(env.VAPID_PUBLIC_KEY), "the public key is shown");
  assert.ok(r.stdout.includes(v.kid), "and its kid");
  assert.ok(!r.stdout.includes(env.VAPID_PRIVATE_KEY) && !r.stderr.includes(env.VAPID_PRIVATE_KEY), "the private key is never printed");
  assert.match(r.stdout, /was not printed/);
  if (process.platform !== "win32") assert.equal(fs.statSync(f).mode & 0o777, 0o600, "mode 0600");
  // never overwrites
  const again = run("--out", f, "--subject", "mailto:ops@example.com");
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  assert.equal(envOf(f).VAPID_PRIVATE_KEY, env.VAPID_PRIVATE_KEY);
});

test("--env appends to an existing file, refuses when VAPID_ lines are there, --force-rotate replaces them", () => {
  const f = path.join(tmp, ".env");
  fs.writeFileSync(f, "SECRET_KEY=keepme\nPORT=3000");          // no final newline
  const r = run("--env", f, "--subject=https://staging.publicaccess.tv");
  assert.equal(r.status, 0, r.stderr);
  const txt = fs.readFileSync(f, "utf8");
  assert.match(txt, /^SECRET_KEY=keepme\nPORT=3000\nVAPID_PUBLIC_KEY=/, "appended on a new line, the rest untouched");
  const first = envOf(f);
  assert.equal(C.loadVapid(first).ok, true);
  const no = run("--env", f, "--subject", "mailto:ops@example.com");
  assert.equal(no.status, 1);
  assert.match(no.stderr, /already has VAPID_ lines/);
  assert.equal(envOf(f).VAPID_PRIVATE_KEY, first.VAPID_PRIVATE_KEY, "unchanged");
  const rot = run("--env", f, "--subject", "mailto:ops@example.com", "--force-rotate");
  assert.equal(rot.status, 0, rot.stderr);
  assert.match(rot.stdout, /ROTATED/);
  const second = envOf(f);
  assert.notEqual(second.VAPID_PUBLIC_KEY, first.VAPID_PUBLIC_KEY);
  assert.equal(second.SECRET_KEY, "keepme");
  assert.equal((fs.readFileSync(f, "utf8").match(/VAPID_PUBLIC_KEY=/g) || []).length, 1, "one pair, not two");
  assert.ok(!rot.stdout.includes(second.VAPID_PRIVATE_KEY));
});

test("usage: nothing to write to, both targets, or a bad subject -> exit 2, nothing printed to stdout", () => {
  for (const args of [[], ["--subject", "mailto:a@b.co"], ["--out", path.join(tmp, "x.env")], ["--out", "a", "--env", "b", "--subject", "mailto:a@b.co"],
                      ["--out", path.join(tmp, "y.env"), "--subject", "ops@example.com"]]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "", "no stdout");
    assert.match(r.stderr, /usage: node tools\/vapid-keys\.js/);
  }
  assert.ok(!fs.existsSync(path.join(tmp, "x.env")) && !fs.existsSync(path.join(tmp, "y.env")));
});
